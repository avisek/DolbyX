/*
 * ddp_processor.c — DolbyX ARM processor with live parameter control
 *
 * Loads libdseffect.so via QEMU, processes PCM, handles control commands
 * for live profile switching and parameter tweaking without audio glitches.
 *
 * Protocol: see ddp_protocol.h
 *
 * Usage:
 *   ddp_processor <libdseffect.so> [sample_rate] [pre_gain_dB] [post_gain_dB]
 */

#include <stdio.h>
#include <stdlib.h>
#include <stdarg.h>
#include <string.h>
#include <math.h>
#include <dlfcn.h>
#include <unistd.h>
#include <signal.h>
#include "audio_effect_defs.h"
#include "ddp_protocol.h"

/* ── Internal Constants ───────────────────────────────────────────── */

#define MAX_FRAMES  8192
#define CHANNELS    2

/* DS1 parameter command IDs (Android API level) */
#define DS_PARAM_DEFINE_SETTINGS     1
#define DS_PARAM_SINGLE_DEVICE_VALUE 3
#define DS_PARAM_DEFINE_PARAMS       5
#define DS_PARAM_VISUALIZER_ENABLE   7

/* Ds1ap direct API (for 48kHz hot-swap) */
typedef void *(*Ds1apNew_t)(int, int, int, int);
typedef void *(*Ds1apBufInit_t)(void *, int, int, int);

/* ── Global gain (set via CLI args for offline processing) ────────── */

float g_pre_gain  = 1.0f;  /* 0 dB default (no pre-gain) */
float g_post_gain = 1.0f;     /*  0.0 dB default */

/* ── Logging ──────────────────────────────────────────────────────── */

static void log_msg(const char *fmt, ...) {
    va_list a;
    va_start(a, fmt);
    vfprintf(stderr, fmt, a);
    va_end(a);
    fflush(stderr);
}

/* ── I/O ──────────────────────────────────────────────────────────── */

static int read_exact(int fd, void *buf, size_t n) {
    size_t total = 0;
    while (total < n) {
        ssize_t r = read(fd, (uint8_t *)buf + total, n - total);
        if (r <= 0) return -1;
        total += r;
    }
    return 0;
}

static int write_exact(int fd, const void *buf, size_t n) {
    size_t total = 0;
    while (total < n) {
        ssize_t w = write(fd, (const uint8_t *)buf + total, n - total);
        if (w <= 0) return -1;
        total += w;
    }
    return 0;
}

/* ── DS1 Low-Level Parameter API ──────────────────────────────────── */

static effect_handle_t g_handle = NULL;

static int ds1_set_raw(int param_cmd, const void *val, int vsize) {
    int total = sizeof(effect_param_t) + sizeof(int32_t) + vsize;
    uint8_t *buf = calloc(1, total);
    if (!buf) return -1;
    effect_param_t *ep = (effect_param_t *)buf;
    ep->psize = sizeof(int32_t);
    ep->vsize = vsize;
    memcpy(buf + sizeof(effect_param_t), &param_cmd, sizeof(int32_t));
    memcpy(buf + sizeof(effect_param_t) + sizeof(int32_t), val, vsize);
    uint32_t rs = sizeof(int32_t);
    int32_t reply = -1;
    (*g_handle)->command(g_handle, EFFECT_CMD_SET_PARAM, total, buf, &rs, &reply);
    free(buf);
    return reply;
}

/*
 * Set a single parameter value via the DS_PARAM protocol.
 */
static int ds1_set_value(int param_index, int16_t value) {
    uint8_t buf[10];
    int pos = 0;
    *(int32_t *)(buf + pos) = 8;              pos += 4;
    *(int16_t *)(buf + pos) = param_index;    pos += 2;
    *(int16_t *)(buf + pos) = 1;              pos += 2;
    *(int16_t *)(buf + pos) = value;          pos += 2;
    return ds1_set_raw(DS_PARAM_SINGLE_DEVICE_VALUE, buf, pos);
}

/*
 * Set an array parameter (e.g., iebt with 20 bands).
 */
static int ds1_set_array(int param_index, const int16_t *values, int count) {
    int bufsize = 4 + 2 + 2 + count * 2;
    uint8_t *buf = calloc(1, bufsize);
    int pos = 0;
    *(int32_t *)(buf + pos) = 8;              pos += 4;
    *(int16_t *)(buf + pos) = param_index;    pos += 2;
    *(int16_t *)(buf + pos) = count;          pos += 2;
    memcpy(buf + pos, values, count * 2);     pos += count * 2;
    int r = ds1_set_raw(DS_PARAM_SINGLE_DEVICE_VALUE, buf, pos);
    free(buf);
    return r;
}

/* ── Parameter Registration ───────────────────────────────────────── */

/* Parameter names — order MUST match DDP_PARAM_* enum.
 * iebt (index 20) is the 20-band IEQ target array. */
static const char g_param_names[][5] = {
    "endp", "vdhe", "dhsb", "dssb", "dssf",
    "ngon", "dvla", "dvle", "dvme",
    "ieon", "iea\0",
    "deon", "dea\0", "ded\0",
    "plmd", "aoon",
    "vmb\0", "vmon",
    "geon", "plb\0",
    "iebt"            /* index 20: IEQ band targets (20 values) */
};

#define TOTAL_PARAMS  21  /* DDP_PARAM_COUNT(20) + iebt(1) */

static void register_parameters(void) {
    int np = TOTAL_PARAMS;

    uint8_t pbuf[2 + TOTAL_PARAMS * 4];
    int pos = 0;
    *(int16_t *)(pbuf + pos) = np; pos += 2;
    for (int i = 0; i < np; i++) {
        memcpy(pbuf + pos, g_param_names[i], 4);
        pos += 4;
    }
    ds1_set_raw(DS_PARAM_DEFINE_PARAMS, pbuf, pos);

    uint8_t sbuf[2 + TOTAL_PARAMS * 3];
    pos = 0;
    *(int16_t *)(sbuf + pos) = np; pos += 2;
    for (int i = 0; i < np; i++) {
        sbuf[pos++] = i;
        *(int16_t *)(sbuf + pos) = 0; pos += 2;
    }
    ds1_set_raw(DS_PARAM_DEFINE_SETTINGS, sbuf, pos);
}

/* ── Profile Data (from ds1-default.xml) ──────────────────────────── */

/*
 * Each profile is an array of DDP_PARAM_COUNT values, ordered to match
 * the DDP_PARAM_* enum. Values are from ds1-default.xml, with endp
 * forced to 2 (headphones) for our use case.
 */
static const int16_t g_profiles[DDP_PROFILE_COUNT][DDP_PARAM_COUNT] = {
    /* Movie: rich IEQ, dialog=3, high surround boost */
    [DDP_PROFILE_MOVIE] = {
        2, 2, 96, 96, 200,     /* endp,vdhe,dhsb,dssb,dssf */
        2, 7, 0, 0,            /* ngon,dvla,dvle,dvme */
        0, 10,                  /* ieon,iea */
        1, 3, 0,                /* deon,dea,ded */
        4, 2,                   /* plmd,aoon */
        144, 0,                 /* vmb,vmon */
        0, 0                    /* geon,plb */
    },
    /* Music: rich IEQ, dialog=2, moderate surround */
    [DDP_PROFILE_MUSIC] = {
        2, 2, 48, 0, 200,
        2, 4, 0, 0,
        0, 10,
        1, 2, 0,
        4, 2,
        144, 0,
        0, 0
    },
    /* Game: open IEQ, leveler ON, vol max ON, virt speaker ON */
    [DDP_PROFILE_GAME] = {
        2, 2, 0, 0, 200,
        2, 0, 1, 0,
        0, 10,
        0, 7, 0,
        4, 2,
        144, 2,
        0, 0
    },
    /* Voice: rich IEQ, strong dialog (10), no virtualizer */
    [DDP_PROFILE_VOICE] = {
        2, 0, 0, 0, 200,
        2, 0, 0, 0,
        0, 10,
        1, 10, 0,
        4, 2,
        144, 0,
        0, 0
    },
    /* Custom 1 */
    [DDP_PROFILE_USER1] = {
        2, 0, 48, 48, 200,
        2, 5, 0, 0,
        0, 10,
        0, 7, 0,
        4, 2,
        144, 2,
        0, 0
    },
    /* Custom 2 */
    [DDP_PROFILE_USER2] = {
        2, 0, 48, 48, 200,
        2, 5, 0, 0,
        0, 10,
        0, 7, 0,
        4, 2,
        144, 2,
        0, 0
    },
};

/* Current parameter values (mutable — updated by SET_PARAM) */
static int16_t g_current_params[DDP_PARAM_COUNT];
static int g_current_profile = DDP_PROFILE_MUSIC;

/* ── IEQ Preset Target Curves (from ds1-default.xml) ─────────────── */

#define IEBT_INDEX  20  /* parameter index for iebt in the defined list */

static const int16_t g_ieq_presets[3][20] = {
    /* Open: airy, bright, wide */
    [DDP_IEQ_OPEN] = {
        117, 133, 188, 176, 141, 149, 175, 185, 185, 200,
        236, 242, 228, 213, 182, 132, 110, 68, -27, -240
    },
    /* Rich: warm, full, lush */
    [DDP_IEQ_RICH] = {
        67, 95, 172, 163, 168, 201, 189, 242, 196, 221,
        192, 186, 168, 139, 102, 57, 35, 9, -55, -235
    },
    /* Focused: vocal-forward, narrow */
    [DDP_IEQ_FOCUSED] = {
        -419, -112, 75, 116, 113, 160, 165, 80, 61, 79,
        98, 121, 64, 70, 44, -71, -33, -100, -238, -411
    },
};

/* Default IEQ preset per profile (from ds1-default.xml <include preset="...">) */
static const int g_profile_ieq_preset[DDP_PROFILE_COUNT] = {
    DDP_IEQ_RICH,     /* Movie */
    DDP_IEQ_RICH,     /* Music */
    DDP_IEQ_OPEN,     /* Game */
    DDP_IEQ_RICH,     /* Voice */
    DDP_IEQ_RICH,     /* Custom 1 */
    DDP_IEQ_RICH,     /* Custom 2 */
};

static int g_current_ieq_preset = -1; /* -1 = manual */

static void apply_ieq_preset(int preset_id) {
    if (preset_id < 0 || preset_id > 2) return;
    g_current_ieq_preset = preset_id;
    ds1_set_array(IEBT_INDEX, g_ieq_presets[preset_id], 20);
    log_msg("[DDP] Applied IEQ preset %d\n", preset_id);
}

static void apply_profile(int profile_id) {
    if (profile_id < 0 || profile_id >= DDP_PROFILE_COUNT) return;
    g_current_profile = profile_id;
    memcpy(g_current_params, g_profiles[profile_id], sizeof(g_current_params));

    for (int i = 0; i < DDP_PARAM_COUNT; i++) {
        ds1_set_value(i, g_current_params[i]);
    }

    /* Apply the profile's default IEQ preset target curve */
    apply_ieq_preset(g_profile_ieq_preset[profile_id]);

    log_msg("[DDP] Applied profile %d\n", profile_id);
}

/* ── Control Command Handler ──────────────────────────────────────── */

static int handle_command(uint32_t cmd) {
    if (cmd == DDP_CMD_SHUTDOWN) {
        return -1; /* signal exit */
    }

    if (cmd == DDP_CMD_PING) {
        uint32_t pong = DDP_CMD_PING;
        write_exact(STDOUT_FILENO, &pong, sizeof(pong));
        return 0;
    }

    if (cmd == DDP_CMD_SET_PARAM) {
        uint16_t param_index = 0;
        int16_t value = 0;
        if (read_exact(STDIN_FILENO, &param_index, 2) < 0) return -1;
        if (read_exact(STDIN_FILENO, &value, 2) < 0) return -1;

        uint32_t status = 0;
        if (param_index < DDP_PARAM_COUNT) {
            g_current_params[param_index] = value;
            int r = ds1_set_value(param_index, value);
            status = (r == 0) ? 0 : 1;
            log_msg("[DDP] SetParam[%d] = %d (status=%d)\n",
                    param_index, value, status);
        } else {
            status = 2; /* invalid index */
        }
        write_exact(STDOUT_FILENO, &status, sizeof(status));
        return 0;
    }

    if (cmd == DDP_CMD_SET_PROFILE) {
        uint32_t profile_id = 0;
        if (read_exact(STDIN_FILENO, &profile_id, sizeof(profile_id)) < 0)
            return -1;

        uint32_t status = 0;
        if (profile_id < DDP_PROFILE_COUNT) {
            apply_profile(profile_id);
        } else {
            status = 1;
        }
        write_exact(STDOUT_FILENO, &status, sizeof(status));
        return 0;
    }

    if (cmd == DDP_CMD_GET_VIS) {
        int16_t vis_data[20] = {0};
        write_exact(STDOUT_FILENO, vis_data, sizeof(vis_data));
        return 0;
    }

    if (cmd == DDP_CMD_SET_IEQ_PRESET) {
        uint32_t preset_id = 0;
        if (read_exact(STDIN_FILENO, &preset_id, sizeof(preset_id)) < 0)
            return -1;

        uint32_t status = 0;
        if (preset_id <= 2) {
            apply_ieq_preset(preset_id);
        } else {
            status = 1;
        }
        write_exact(STDOUT_FILENO, &status, sizeof(status));
        return 0;
    }

    /* Unknown command */
    log_msg("[DDP] Unknown command: 0x%08X\n", cmd);
    return 0;
}

/* ── Main ─────────────────────────────────────────────────────────── */

int main(int argc, char *argv[]) {
    if (argc < 2) {
        log_msg("Usage: %s <libdseffect.so> [rate] [pre_gain_dB] [post_gain_dB]\n",
                argv[0]);
        return 1;
    }

    const char *lib_path = argv[1];
    int sample_rate     = (argc >= 3) ? atoi(argv[2]) : 48000;
    float pre_gain_db   = (argc >= 4) ? atof(argv[3]) : 0.0f;
    float post_gain_db  = (argc >= 5) ? atof(argv[4]) : 0.0f;

    g_pre_gain  = powf(10.0f, pre_gain_db / 20.0f);
    g_post_gain = powf(10.0f, post_gain_db / 20.0f);

    signal(SIGPIPE, SIG_IGN);

    log_msg("[DDP] Loading %s (rate=%d, pre=%.1fdB, post=%.1fdB)\n",
            lib_path, sample_rate, pre_gain_db, post_gain_db);

    /* ── Load library ──────────────────────────────────────────────── */

    void *lib = dlopen(lib_path, RTLD_NOW);
    if (!lib) { log_msg("[DDP] dlopen: %s\n", dlerror()); return 1; }

    EffectQueryNumberEffects_t QueryNumEffects = dlsym(lib, "EffectQueryNumberEffects");
    EffectQueryEffect_t QueryEffect = dlsym(lib, "EffectQueryEffect");
    EffectCreate_t Create = dlsym(lib, "EffectCreate");
    EffectRelease_t Release = dlsym(lib, "EffectRelease");

    if (!QueryNumEffects || !QueryEffect || !Create || !Release) {
        log_msg("[DDP] Missing API symbols\n"); return 1;
    }

    uint32_t num = 0;
    QueryNumEffects(&num);
    if (num == 0) { log_msg("[DDP] No effects\n"); return 1; }

    effect_descriptor_t desc;
    QueryEffect(0, &desc);
    log_msg("[DDP] Effect: '%s'\n", desc.name);

    /* ── Create effect ─────────────────────────────────────────────── */

    int32_t ret = Create(&desc.uuid, 0, 0, &g_handle);
    if (ret != 0 || !g_handle) { log_msg("[DDP] Create failed\n"); return 1; }

    uint32_t rs = 4;
    int32_t r = -1;
    (*g_handle)->command(g_handle, EFFECT_CMD_INIT, 0, NULL, &rs, &r);

    /* ── Hot-swap to requested sample rate ──────────────────────────── */

    if (sample_rate == 48000 || sample_rate == 32000) {
        Ds1apNew_t DsNew = dlsym(lib, "_ZN5Ds1ap3NewEiiii");
        Ds1apBufInit_t DsBufInit = dlsym(lib, "Ds1apBufferInit");

        if (DsNew && DsBufInit) {
            void *new_ds1ap = DsNew(0, sample_rate, 2, 0);
            if (new_ds1ap) {
                DsBufInit(new_ds1ap, 256, 2, 16);
                uint32_t *ctx = (uint32_t *)g_handle;
                ctx[17] = (uint32_t)(uintptr_t)new_ds1ap;
                ctx[3]  = sample_rate;
                ctx[11] = sample_rate;
                log_msg("[DDP] Hot-swapped to %dHz\n", sample_rate);
            } else {
                log_msg("[DDP] Hot-swap failed, using 44100Hz\n");
                sample_rate = 44100;
            }
        }
    }

    /* ── Register parameters and apply default profile ─────────────── */

    register_parameters();
    apply_profile(DDP_PROFILE_MUSIC);

    /* ── Enable ────────────────────────────────────────────────────── */

    rs = 4; r = -1;
    (*g_handle)->command(g_handle, EFFECT_CMD_ENABLE, 0, NULL, &rs, &r);

    log_msg("[DDP] Ready (rate=%d, pre=%.1fdB/%.4f, post=%.1fdB/%.4f)\n",
            sample_rate, pre_gain_db, g_pre_gain, post_gain_db, g_post_gain);

    /* ── Allocate buffers ──────────────────────────────────────────── */

    int16_t *pcm_in  = calloc(MAX_FRAMES * CHANNELS, sizeof(int16_t));
    int16_t *pcm_out = calloc(MAX_FRAMES * CHANNELS, sizeof(int16_t));
    if (!pcm_in || !pcm_out) { log_msg("[DDP] alloc failed\n"); return 1; }

    /* ── Signal ready ──────────────────────────────────────────────── */

    uint32_t magic = DDP_READY_MAGIC;
    if (write_exact(STDOUT_FILENO, &magic, sizeof(magic)) < 0) return 1;

    /* ── Main loop ─────────────────────────────────────────────────── */

    for (;;) {
        uint32_t frame_count = 0;
        if (read_exact(STDIN_FILENO, &frame_count, sizeof(frame_count)) < 0)
            break;

        /* Control commands use high frame_count values (>= 0xFFFFFFE0) */
        if (frame_count >= 0xFFFFFFE0) {
            if (handle_command(frame_count) < 0) break;
            continue;
        }

        /* Validate audio frame count */
        if (frame_count > MAX_FRAMES) {
            log_msg("[DDP] frame_count too large: %u\n", frame_count);
            break;
        }

        size_t pcm_bytes = frame_count * CHANNELS * sizeof(int16_t);
        if (read_exact(STDIN_FILENO, pcm_in, pcm_bytes) < 0) break;

        /* Pre-gain */
        if (g_pre_gain != 1.0f) {
            for (uint32_t i = 0; i < frame_count * CHANNELS; i++) {
                float s = pcm_in[i] * g_pre_gain;
                pcm_in[i] = (int16_t)(s > 32767 ? 32767 : s < -32767 ? -32767 : s);
            }
        }

        /* Zero output buffer (ACCUMULATE mode) */
        memset(pcm_out, 0, pcm_bytes);

        /* Process */
        audio_buffer_t in_buf  = { .frameCount = frame_count, .s16 = pcm_in };
        audio_buffer_t out_buf = { .frameCount = frame_count, .s16 = pcm_out };
        ret = (*g_handle)->process(g_handle, &in_buf, &out_buf);
        if (ret != 0) memcpy(pcm_out, pcm_in, pcm_bytes);

        /* Post-gain */
        if (g_post_gain != 1.0f) {
            for (uint32_t i = 0; i < frame_count * CHANNELS; i++) {
                float s = pcm_out[i] * g_post_gain;
                pcm_out[i] = (int16_t)(s > 32767 ? 32767 : s < -32767 ? -32767 : s);
            }
        }

        if (write_exact(STDOUT_FILENO, pcm_out, pcm_bytes) < 0) break;
    }

    log_msg("[DDP] Cleaning up\n");
    Release(g_handle);
    dlclose(lib);
    free(pcm_in);
    free(pcm_out);
    return 0;
}
