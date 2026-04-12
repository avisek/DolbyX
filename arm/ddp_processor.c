/*
 * ddp_processor.c — Dolby Digital Plus ARM processor
 *
 * Loads libdseffect.so via QEMU, processes PCM through the DS1 effect.
 * Supports native 44100Hz and 48000Hz via Ds1ap hot-swap technique.
 *
 * Protocol (binary, little-endian over stdin/stdout):
 *   Startup:  processor writes 4-byte magic 0xDD901DAA
 *   Process:  host writes uint32_t frame_count + int16_t pcm[frames*2]
 *             processor writes int16_t pcm[frames*2]
 *   Shutdown: host writes frame_count = 0xFFFFFFFF
 *
 * Usage:
 *   ddp_processor <libdseffect.so> [sample_rate] [pre_gain_db] [post_gain_db]
 *
 *   sample_rate:  44100 (default) or 48000
 *   pre_gain_db:  attenuation before DDP, e.g. -6.0 (default: -9.0)
 *   post_gain_db: boost after DDP, e.g. 6.0 (default: 9.0)
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

/* ── Constants ────────────────────────────────────────────────────── */

#define READY_MAGIC       0xDD901DAA
#define CMD_SHUTDOWN      0xFFFFFFFF
#define CMD_PING          0xFFFFFFFD
#define CMD_SET_PROFILE   0xFFFFFFF0
#define MAX_FRAMES        8192
#define CHANNELS          2

/* DS1 parameter commands */
#define DS_PARAM_DEFINE_SETTINGS     1
#define DS_PARAM_SINGLE_DEVICE_VALUE 3
#define DS_PARAM_DEFINE_PARAMS       5

/* Ds1ap direct API (for 48kHz hot-swap) */
typedef void* (*Ds1apNew_t)(int endp, int rate, int ch, int mode);
typedef void* (*Ds1apBufInit_t)(void* ctx, int blocksize, int ch, int bits);

/* ── Logging ──────────────────────────────────────────────────────── */

static void log_msg(const char* fmt, ...) {
    va_list args;
    va_start(args, fmt);
    vfprintf(stderr, fmt, args);
    va_end(args);
    fflush(stderr);
}

/* ── I/O ──────────────────────────────────────────────────────────── */

static int read_exact(int fd, void* buf, size_t n) {
    size_t total = 0;
    while (total < n) {
        ssize_t r = read(fd, (uint8_t*)buf + total, n - total);
        if (r <= 0) return -1;
        total += r;
    }
    return 0;
}

static int write_exact(int fd, const void* buf, size_t n) {
    size_t total = 0;
    while (total < n) {
        ssize_t w = write(fd, (const uint8_t*)buf + total, n - total);
        if (w <= 0) return -1;
        total += w;
    }
    return 0;
}

/* ── DS1 Parameter Protocol ───────────────────────────────────────── */

static int ds1_set_param(effect_handle_t handle, int param_id,
                         const void* value, int value_size) {
    int total = sizeof(effect_param_t) + sizeof(int32_t) + value_size;
    uint8_t* buf = calloc(1, total);
    if (!buf) return -1;
    effect_param_t* ep = (effect_param_t*)buf;
    ep->status = 0;
    ep->psize = sizeof(int32_t);
    ep->vsize = value_size;
    memcpy(buf + sizeof(effect_param_t), &param_id, sizeof(int32_t));
    memcpy(buf + sizeof(effect_param_t) + sizeof(int32_t), value, value_size);
    uint32_t reply_size = sizeof(int32_t);
    int32_t reply = -1;
    (*handle)->command(handle, EFFECT_CMD_SET_PARAM, total, buf, &reply_size, &reply);
    free(buf);
    return reply;
}

/* ── Configure headphone mode with Music profile defaults ─────── */

static void setup_default_music_headphone(effect_handle_t handle) {
    /* Define all controllable parameters */
    const char names[][5] = {
        "endp", "vdhe", "dhsb", "dssb", "dssf",
        "ngon", "dvla", "dvle", "dvme",
        "ieon", "iea\0",
        "deon", "dea\0", "ded\0",
        "plmd", "aoon",
        "vmb\0", "vmon",
        "geon", "plb\0"
    };
    int nparam = 20;

    /* Step 1: Define param names */
    uint8_t pbuf[2 + 20*4];
    int pos = 0;
    *(int16_t*)(pbuf + pos) = nparam; pos += 2;
    for (int i = 0; i < nparam; i++) {
        memcpy(pbuf + pos, names[i], 4); pos += 4;
    }
    ds1_set_param(handle, DS_PARAM_DEFINE_PARAMS, pbuf, pos);

    /* Step 2: Map 1:1 settings */
    uint8_t sbuf[2 + 20*3];
    pos = 0;
    *(int16_t*)(sbuf + pos) = nparam; pos += 2;
    for (int i = 0; i < nparam; i++) {
        sbuf[pos++] = i;
        *(int16_t*)(sbuf + pos) = 0; pos += 2;
    }
    ds1_set_param(handle, DS_PARAM_DEFINE_SETTINGS, sbuf, pos);

    /* Step 3: Music profile defaults from ds1-default.xml — UNMODIFIED */
    int16_t values[] = {
        2,     /*  0: endp = HEADPHONES */
        2,     /*  1: vdhe = AUTO (Dolby Headphone) */
        48,    /*  2: dhsb = 48 (headphone surround boost) */
        0,     /*  3: dssb = 0 */
        200,   /*  4: dssf = 200 */
        2,     /*  5: ngon = AUTO (Next Gen Surround) */
        4,     /*  6: dvla = 4 (Volume Leveler amount) */
        0,     /*  7: dvle = OFF (ds1-default: Music profile has dvle=0) */
        0,     /*  8: dvme = OFF */
        0,     /*  9: ieon = OFF (ds1-default: Music profile has ieon=0) */
        10,    /* 10: iea  = 10 */
        1,     /* 11: deon = ON (Dialog Enhancer) */
        2,     /* 12: dea  = 2 */
        0,     /* 13: ded  = 0 */
        4,     /* 14: plmd = AUTO */
        2,     /* 15: aoon = AUTO */
        144,   /* 16: vmb  = 144 (+7.2dB) — ORIGINAL DEFAULT */
        0,     /* 17: vmon = OFF */
        0,     /* 18: geon = OFF */
        0,     /* 19: plb  = 0 */
    };

    for (int i = 0; i < nparam; i++) {
        uint8_t vbuf[10];
        pos = 0;
        *(int32_t*)(vbuf + pos) = 8;         pos += 4; /* device=wired headphone */
        *(int16_t*)(vbuf + pos) = i;          pos += 2;
        *(int16_t*)(vbuf + pos) = 1;          pos += 2;
        *(int16_t*)(vbuf + pos) = values[i];  pos += 2;
        ds1_set_param(handle, DS_PARAM_SINGLE_DEVICE_VALUE, vbuf, pos);
    }
}

/* ── Main ─────────────────────────────────────────────────────────── */

int main(int argc, char* argv[]) {
    if (argc < 2) {
        log_msg("Usage: %s <libdseffect.so> [rate] [pre_gain_dB] [post_gain_dB]\n", argv[0]);
        return 1;
    }

    const char* lib_path = argv[1];
    int sample_rate = (argc >= 3) ? atoi(argv[2]) : 48000;
    float pre_gain_db  = (argc >= 4) ? atof(argv[3]) : -6.0f;
    float post_gain_db = (argc >= 5) ? atof(argv[4]) : 0.0f;

    float pre_gain  = powf(10.0f, pre_gain_db / 20.0f);
    float post_gain = powf(10.0f, post_gain_db / 20.0f);

    signal(SIGPIPE, SIG_IGN);

    log_msg("[DDP] Loading %s (rate=%d, pre=%.1fdB, post=%.1fdB)\n",
            lib_path, sample_rate, pre_gain_db, post_gain_db);

    /* ── Load library ──────────────────────────────────────────────── */

    void* lib = dlopen(lib_path, RTLD_NOW);
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

    /* ── Create effect (always starts at 44100Hz internally) ─────── */

    effect_handle_t handle = NULL;
    int32_t ret = Create(&desc.uuid, 0, 0, &handle);
    if (ret != 0 || !handle) { log_msg("[DDP] Create failed\n"); return 1; }

    uint32_t rs = 4; int32_t r = -1;
    (*handle)->command(handle, EFFECT_CMD_INIT, 0, NULL, &rs, &r);

    /* ── Hot-swap to 48kHz if requested ────────────────────────────── */

    if (sample_rate == 48000) {
        Ds1apNew_t DsNew = dlsym(lib, "_ZN5Ds1ap3NewEiiii");
        Ds1apBufInit_t DsBufInit = dlsym(lib, "Ds1apBufferInit");

        if (DsNew && DsBufInit) {
            void* new_ds1ap = DsNew(0, 48000, 2, 0);
            if (new_ds1ap) {
                DsBufInit(new_ds1ap, 256, 2, 16);
                uint32_t* ctx = (uint32_t*)handle;
                ctx[17] = (uint32_t)(uintptr_t)new_ds1ap; /* Ds1ap ptr */
                ctx[3]  = 48000;  /* input sample rate */
                ctx[11] = 48000;  /* output sample rate */
                log_msg("[DDP] Hot-swapped to native 48kHz\n");
            } else {
                log_msg("[DDP] WARNING: 48k Ds1ap failed, using 44.1k\n");
                sample_rate = 44100;
            }
        }
    }

    /* ── Configure headphone mode with original Music defaults ───── */

    setup_default_music_headphone(handle);

    /* ── Enable ────────────────────────────────────────────────────── */

    rs = 4; r = -1;
    (*handle)->command(handle, EFFECT_CMD_ENABLE, 0, NULL, &rs, &r);

    log_msg("[DDP] Ready (rate=%d, pre=%.1fdB/%.4f, post=%.1fdB/%.4f)\n",
            sample_rate, pre_gain_db, pre_gain, post_gain_db, post_gain);

    /* ── Allocate buffers ──────────────────────────────────────────── */

    int16_t* pcm_in  = calloc(MAX_FRAMES * CHANNELS, sizeof(int16_t));
    int16_t* pcm_out = calloc(MAX_FRAMES * CHANNELS, sizeof(int16_t));
    if (!pcm_in || !pcm_out) { log_msg("[DDP] alloc failed\n"); return 1; }

    /* ── Signal ready ──────────────────────────────────────────────── */

    uint32_t magic = READY_MAGIC;
    if (write_exact(STDOUT_FILENO, &magic, sizeof(magic)) < 0) return 1;

    /* ── Processing loop ───────────────────────────────────────────── */

    for (;;) {
        uint32_t frame_count = 0;
        if (read_exact(STDIN_FILENO, &frame_count, sizeof(frame_count)) < 0) break;

        if (frame_count == CMD_SHUTDOWN) break;
        if (frame_count == CMD_PING) {
            uint32_t pong = CMD_PING;
            write_exact(STDOUT_FILENO, &pong, sizeof(pong));
            continue;
        }
        if (frame_count == CMD_SET_PROFILE) {
            uint32_t p = 0;
            if (read_exact(STDIN_FILENO, &p, sizeof(p)) < 0) break;
            log_msg("[DDP] Profile → %u\n", p);
            uint32_t ack = CMD_SET_PROFILE;
            write_exact(STDOUT_FILENO, &ack, sizeof(ack));
            continue;
        }
        if (frame_count > MAX_FRAMES) {
            log_msg("[DDP] frame_count too large: %u\n", frame_count);
            break;
        }

        size_t pcm_bytes = frame_count * CHANNELS * sizeof(int16_t);
        if (read_exact(STDIN_FILENO, pcm_in, pcm_bytes) < 0) break;

        /* ── Pre-gain: attenuate input to give DDP headroom ──────── */
        /* On Android, audio enters DDP at system volume (~50-70%),
         * not at 0dBFS. This pre-gain simulates that attenuation,
         * letting vmb (+7.2dB) and the Peak Limiter work as designed. */
        if (pre_gain != 1.0f) {
            for (uint32_t i = 0; i < frame_count * CHANNELS; i++) {
                float s = pcm_in[i] * pre_gain;
                pcm_in[i] = (int16_t)(s > 32767 ? 32767 : (s < -32767 ? -32767 : s));
            }
        }

        /* ── Zero output (ACCUMULATE mode fix) ───────────────────── */
        memset(pcm_out, 0, pcm_bytes);

        /* ── Process ──────────────────────────────────────────────── */
        audio_buffer_t in_buf  = { .frameCount = frame_count, .s16 = pcm_in };
        audio_buffer_t out_buf = { .frameCount = frame_count, .s16 = pcm_out };

        ret = (*handle)->process(handle, &in_buf, &out_buf);
        if (ret != 0) {
            memcpy(pcm_out, pcm_in, pcm_bytes);
        }

        /* ── Post-gain: restore level after DDP processing ───────── */
        if (post_gain != 1.0f) {
            for (uint32_t i = 0; i < frame_count * CHANNELS; i++) {
                float s = pcm_out[i] * post_gain;
                /* Soft clip to avoid harsh digital clipping */
                if (s > 32767) s = 32767;
                else if (s < -32767) s = -32767;
                pcm_out[i] = (int16_t)s;
            }
        }

        if (write_exact(STDOUT_FILENO, pcm_out, pcm_bytes) < 0) break;
    }

    log_msg("[DDP] Cleaning up\n");
    Release(handle);
    dlclose(lib);
    free(pcm_in);
    free(pcm_out);
    return 0;
}
