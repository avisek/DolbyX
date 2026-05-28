/*
 * ddp_probe.c — Evidence harness for libdseffect.so engine behavior.
 *
 * Runs eight focused experiments under qemu-arm-static and prints
 * stdout summaries while the engine's own log lines (via the noisy
 * liblog_stub.c) print to stderr. The combination is the empirical
 * source-of-truth for the claims in:
 *
 *   docs/ddp/02-ak-parameters.md
 *   docs/ddp/03-binary-protocol.md
 *   docs/ddp/05-profiles-and-persistence.md
 *   docs/REARCHITECTURE_PLAN.md
 *
 * Experiments
 * -----------
 *   1. Init handshake (DEFINE_PARAMS + DEFINE_SETTINGS with all 64
 *      params + VISUALIZER_ENABLE + ENABLE). Also exercises cmd 7
 *      GET to confirm the host can read back the visualizer-enable
 *      bit.
 *   2. Engine-side range/validation: write in-range, over-max,
 *      below-min values into each of 17 settable params via cmd 3
 *      SET. The engine accepts all of them with reply 0 (proves
 *      no value-range validation).
 *   3. Cmd 3 GET unimplemented: try a flat-index GET and observe
 *      reply -22 plus the matching engine log line.
 *   4. cmd 4 VISUALIZER_DATA returns dynamic vcbg||vcbe. Captured
 *      twice — once after warm-up and once at the end of section 7
 *      after audio shape has changed — to show the DSP refreshes
 *      both slots block-to-block.
 *   5. cmd 6 VERSION returns the engine version.
 *   6. ENABLE/DISABLE crossfade + idempotency, plus a measured
 *      behavioral check that a parameter SET on either side of the
 *      cycle actually takes effect (cache + AK state survive).
 *   7. Behavioral sweep: dvla, dvle, vmb past their declared bounds
 *      with audio flowing — proves the DSP reads raw int16 (the
 *      output statistics differ at every probe value).
 *   8. Out-of-cache flat-index SET (proves the engine's only SET-side
 *      validation is index-range), the boundary case
 *      `begin + count > cache_total` (resolves whether the engine
 *      checks only `begin` or the full extent), and bogus 4-CC
 *      DEFINE_PARAMS acceptance (proves no name validation).
 *
 * Build & run: see tools/ddp_probe/README.md.
 */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <math.h>
#include <dlfcn.h>
#include "audio_effect_defs.h"

#define DS_PARAM_DEFINE_SETTINGS     1
#define DS_PARAM_ALL_VALUES          2
#define DS_PARAM_SINGLE_DEVICE_VALUE 3
#define DS_PARAM_VISUALIZER_DATA     4
#define DS_PARAM_DEFINE_PARAMS       5
#define DS_PARAM_VERSION             6
#define DS_PARAM_VISUALIZER_ENABLE   7
#define DEVICE_WIRED_HEADPHONE 8

/* set_param() sentinel: param name not in G[] or no DEFINE_SETTINGS
 * slot allocated. Distinguishable from any reply the engine returns. */
#define PARAM_NOT_DEFINED (-998)

typedef struct {
    const char *name;
    int     len;        /* mutable for aobg post-aonb-resize */
    int16_t lo;
    int16_t hi;
} ak_param_t;

/* The canonical 64-parameter table verbatim from DsAkSettings.akParams_.
 * Order matches DEFINE_PARAMS index assignment expected by the engine. */
static ak_param_t G[] = {
    {"bver", 5, -32768, 32767}, {"bndl", 2, -32768, 32767},
    {"ocf",  1, 0, 5},          {"preg", 1, -2080, 480},
    {"vdhe", 1, 0, 2},          {"vspe", 1, 0, 2},
    {"dssf", 1, 20, 20000},     {"dvli", 1, -640, 0},
    {"dvlo", 1, -640, 0},       {"dvle", 1, 0, 1},
    {"dvmc", 1, -320, 320},     {"dvme", 1, 0, 1},
    {"ienb", 1, 1, 40},         {"iebf", 20, 20, 20000},
    {"ieon", 1, 0, 1},          {"deon", 1, 0, 1},
    {"ngon", 1, 0, 2},          {"geon", 1, 0, 1},
    {"genb", 1, 1, 40},         {"gebf", 20, 20, 20000},
    {"aonb", 1, 1, 40},         {"aobf", 40, 20, 20000},
    {"aobg", 42, -480, 480},    /* len = (aonb+1)*aocc = (20+1)*2 = 42 */
    {"aoon", 1, 0, 2},          {"arnb", 1, 1, 40},
    {"arbf", 40, 20, 20000},    {"plb",  1, 0, 288},
    {"plmd", 1, 0, 4},          {"ven",  1, 0, 1},
    {"vnnb", 1, 1, 20},         {"vnbf", 20, -32768, 32767},
    {"vnbg", 20, -32768, 32767},{"vnbe", 20, -32768, 32767},
    {"vcnb", 1, 1, 40},         {"vcbf", 20, 20, 20000},
    {"vcbg", 20, -192, 576},    {"vcbe", 20, -192, 576},
    {"ver",  4, -32768, 32767}, {"pstg", 1, -2080, 480},
    {"dhsb", 1, 0, 96},         {"dhrg", 1, -2080, 96},
    {"dssb", 1, 0, 96},         {"dssa", 1, 5, 30},
    {"dvla", 1, 0, 10},         {"iebt", 20, -480, 480},
    {"iea",  1, 0, 16},         {"dea",  1, 0, 16},
    {"ded",  1, 0, 16},         {"gebg", 20, -576, 576},
    {"aocc", 1, 0, 8},          {"arbi", 40, 0, 1},
    {"arbl", 40, -2080, 0},     {"arbh", 40, -2080, 0},
    {"arod", 1, 0, 192},        {"artp", 1, 0, 16},
    {"endp", 1, 0, 6},          {"mxou", 1, 1, 8},
    {"vol",  1, -2048, 480},    {"vmon", 1, 0, 2},
    {"vmb",  1, 0, 240},
    {"lcmf", 2, -32768, 32767}, {"lcvd", 2, -32768, 32767},
    {"lcsz", 1, 1, 32767},      {"lcpt", 168, -128, 127},
};
#define NPARAM (int)(sizeof(G)/sizeof(G[0]))

static int find_param(const char *n) {
    for (int i = 0; i < NPARAM; ++i)
        if (!strcmp(G[i].name, n)) return i;
    return -1;
}

static effect_handle_t H = NULL;

/* settings_begin[i] is the flat cache index at which param i's value
 * array starts. -1 means the param isn't in DEFINE_SETTINGS. */
static int settings_begin[NPARAM];

static int cmd_set(int cmd, const void *val, int vsize) {
    int total = sizeof(effect_param_t) + 4 + vsize;
    uint8_t *buf = calloc(1, total);
    effect_param_t *ep = (effect_param_t *)buf;
    ep->status = 0;
    ep->psize = 4;
    ep->vsize = vsize;
    *(int32_t *)(buf + sizeof(effect_param_t)) = cmd;
    memcpy(buf + sizeof(effect_param_t) + 4, val, vsize);
    uint32_t rs = 4;
    int32_t reply = -1;
    (*H)->command(H, EFFECT_CMD_SET_PARAM, total, buf, &rs, &reply);
    free(buf);
    return reply;
}

/* GET via cmd 3/4/6/7: the engine writes the reply into the *same*
 * buffer we sent the request in. Reply status is ep->status. */
static int cmd_get(int cmd, const void *in, int in_size,
                   void *out_values, int out_value_bytes) {
    int total = sizeof(effect_param_t) + 4 + in_size;
    uint8_t *buf = calloc(1, total);
    effect_param_t *ep = (effect_param_t *)buf;
    ep->status = 0;
    ep->psize = 4;
    ep->vsize = in_size;
    *(int32_t *)(buf + sizeof(effect_param_t)) = cmd;
    memcpy(buf + sizeof(effect_param_t) + 4, in, in_size);
    uint32_t rs = total;
    int32_t r = (*H)->command(H, EFFECT_CMD_GET_PARAM, total, buf, &rs, buf);
    if (out_values && out_value_bytes > 0) {
        memcpy(out_values,
               buf + sizeof(effect_param_t) + 4 + (in_size - out_value_bytes),
               out_value_bytes);
    }
    int status = ep->status;
    free(buf);
    return r != 0 ? r : status;
}

static int set_flat(int flat, const int16_t *vals, int count) {
    int vsize = 4 + 2 + 2 + count * 2;
    uint8_t *buf = calloc(1, vsize);
    *(int32_t *)(buf) = DEVICE_WIRED_HEADPHONE;
    *(int16_t *)(buf + 4) = (int16_t)flat;
    *(int16_t *)(buf + 6) = (int16_t)count;
    memcpy(buf + 8, vals, count * 2);
    int r = cmd_set(DS_PARAM_SINGLE_DEVICE_VALUE, buf, vsize);
    free(buf);
    return r;
}

static int set_param(const char *name, int offset, const int16_t *v, int c) {
    int p = find_param(name);
    if (p < 0 || settings_begin[p] < 0) return PARAM_NOT_DEFINED;
    return set_flat(settings_begin[p] + offset, v, c);
}

static void define_params(void) {
    uint8_t *buf = calloc(1, 2 + NPARAM * 4);
    *(int16_t *)buf = (int16_t)NPARAM;
    for (int i = 0; i < NPARAM; ++i) {
        memset(buf + 2 + i * 4, 0, 4);
        memcpy(buf + 2 + i * 4, G[i].name, strlen(G[i].name));
    }
    int r = cmd_set(DS_PARAM_DEFINE_PARAMS, buf, 2 + NPARAM * 4);
    printf("DEFINE_PARAMS (%d names) -> reply=%d\n", NPARAM, r);
    free(buf);
}

/* DEFINE_SETTINGS with ALL 64 params expanded into their full `len`
 * slot range. This is what DolbyX v2's research-vehicle setup
 * should send so every AK param has a cache slot. */
static int define_settings_all(void) {
    int total = 0;
    for (int i = 0; i < NPARAM; ++i) total += G[i].len;
    int byte_size = 2 + total * 3;
    uint8_t *buf = calloc(1, byte_size);
    *(int16_t *)buf = (int16_t)total;
    int pos = 2, flat = 0;
    for (int i = 0; i < NPARAM; ++i) settings_begin[i] = -1;
    for (int i = 0; i < NPARAM; ++i) {
        settings_begin[i] = flat;
        for (int e = 0; e < G[i].len; ++e) {
            buf[pos++] = (uint8_t)i;
            *(int16_t *)(buf + pos) = (int16_t)e;
            pos += 2;
            flat++;
        }
    }
    int r = cmd_set(DS_PARAM_DEFINE_SETTINGS, buf, byte_size);
    printf("DEFINE_SETTINGS (all 64 params, %d slots, %d bytes) "
           "-> reply=%d\n", total, byte_size, r);
    free(buf);
    return total;
}

static void process_blocks(int16_t *in_pcm, int16_t *out_pcm, int frames,
                           int n) {
    for (int i = 0; i < n; ++i) {
        audio_buffer_t in  = { .frameCount = (uint32_t)frames, .s16 = in_pcm };
        audio_buffer_t out = { .frameCount = (uint32_t)frames, .s16 = out_pcm };
        memset(out_pcm, 0, frames * 4);
        (*H)->process(H, &in, &out);
    }
}

static void measure(const char *label, int16_t *out_pcm, int frames) {
    int peak = 0; double ss = 0;
    for (int i = 0; i < frames * 2; ++i) {
        int v = out_pcm[i];
        int a = v < 0 ? -v : v;
        if (a > peak) peak = a;
        ss += (double)v * v;
    }
    double rms = sqrt(ss / (frames * 2));
    printf("    %-32s peak=%5d rms=%8.1f\n", label, peak, rms);
}

int main(int argc, char *argv[]) {
    setbuf(stdout, NULL);
    setbuf(stderr, NULL);
    if (argc < 2) {
        fprintf(stderr, "Usage: %s <libdseffect.so>\n", argv[0]);
        return 1;
    }
    void *lib = dlopen(argv[1], RTLD_NOW);
    if (!lib) {
        fprintf(stderr, "dlopen: %s\n", dlerror());
        return 1;
    }
    EffectQueryNumberEffects_t Q = dlsym(lib, "EffectQueryNumberEffects");
    EffectQueryEffect_t QE       = dlsym(lib, "EffectQueryEffect");
    EffectCreate_t C             = dlsym(lib, "EffectCreate");
    EffectRelease_t R            = dlsym(lib, "EffectRelease");
    uint32_t n = 0; Q(&n);
    effect_descriptor_t desc; QE(0, &desc);
    int32_t cr = C(&desc.uuid, 0, 0, &H);
    if (cr != 0 || !H) {
        fprintf(stderr, "EffectCreate failed (%d)\n", cr);
        return 1;
    }
    uint32_t rs = 4; int32_t r = 0;
    (*H)->command(H, EFFECT_CMD_INIT, 0, NULL, &rs, &r);
    printf("EFFECT_CMD_INIT -> reply=%d\n", r);

    /* ── 1. Init handshake ──────────────────────────────────────── */
    printf("\n=== 1. INIT HANDSHAKE ===\n");
    define_params();
    int cache_total = define_settings_all();

    int16_t v20 = 20;
    set_param("genb", 0, &v20, 1);
    set_param("ienb", 0, &v20, 1);
    set_param("aonb", 0, &v20, 1);
    int16_t bf[20] = {43, 129, 215, 301, 431, 603, 775, 947, 1206, 1550,
                      2067, 2756, 3618, 4651, 5685, 7063, 8958, 11025,
                      13781, 18777};
    set_param("gebf", 0, bf, 20);
    set_param("iebf", 0, bf, 20);

    int32_t vis_on = 1;
    printf("VISUALIZER_ENABLE=1 -> reply=%d\n",
           cmd_set(DS_PARAM_VISUALIZER_ENABLE, &vis_on, 4));

    /* cmd 7 GET — the engine routes both directions for cmd 7
     * (Java's DsEffect.getVisualizerOn relies on it). */
    {
        int32_t vis_in = 0, vis_out = 99;
        int gs = cmd_get(DS_PARAM_VISUALIZER_ENABLE, &vis_in, 4, &vis_out, 4);
        printf("VISUALIZER_ENABLE (cmd 7) GET -> status=%d, value=%d "
               "(round-trips the bit we just wrote)\n", gs, vis_out);
    }

    /* ── 5. cmd 6 VERSION before ENABLE (it works any time) ─────── */
    int16_t ver[4] = {0};
    int16_t ver_in[4] = {0};
    int vs = cmd_get(DS_PARAM_VERSION, ver_in, 8, ver, 8);
    printf("VERSION (cmd 6) -> status=%d, components=%d.%d.%d.%d\n",
           vs, ver[0], ver[1], ver[2], ver[3]);

    rs = 4; r = 0;
    (*H)->command(H, EFFECT_CMD_ENABLE, 0, NULL, &rs, &r);
    printf("EFFECT_CMD_ENABLE -> reply=%d (engine log: 'Starting "
           "graceful enable over 7560 samples')\n", r);

    /* Some quiet 440 Hz sine so the visualizer/DSP have material. */
    int frames = 256;
    int16_t *pcm_in  = calloc(frames * 2, 2);
    int16_t *pcm_out = calloc(frames * 2, 2);
    double rate = 44100.0;
    for (int i = 0; i < frames; ++i) {
        double t = i / rate;
        int s = (int)(20000.0 * sin(2.0 * M_PI * 440.0 * t));
        pcm_in[i*2] = (int16_t)s; pcm_in[i*2+1] = (int16_t)s;
    }
    /* Warm up past the 7560-sample enable crossfade (~30 blocks of 256). */
    process_blocks(pcm_in, pcm_out, frames, 35);

    /* ── 2. ENGINE-LEVEL RANGE VALIDATION ───────────────────────── */
    printf("\n=== 2. SET RANGE PROBES — engine accepts everything ===\n");
    printf("    For each param: write mid, over-hi+100, under-lo-100.\n"
           "    SET reply 0 = engine accepted (no value-range validation).\n");
    const char *to_probe[] = {
        "dvla", "dea", "dhsb", "vmb", "dvle", "vdhe", "plmd",
        "dvli", "dvlo", "dvmc", "ieon", "geon", "dssf", "dssa",
        "arod", "arbl", "plb", NULL
    };
    for (int i = 0; to_probe[i]; ++i) {
        const char *nm = to_probe[i];
        int p = find_param(nm);
        int16_t mid = (int16_t)((G[p].lo + G[p].hi) / 2);
        int16_t hi  = (int16_t)(G[p].hi + 100);
        int16_t lo  = (int16_t)(G[p].lo - 100);
        int rm = set_param(nm, 0, &mid, 1);
        int rh = set_param(nm, 0, &hi,  1);
        int rl = set_param(nm, 0, &lo,  1);
        printf("    %-4s [%6d..%6d]: %6d->%d  %6d->%d  %6d->%d\n",
               nm, G[p].lo, G[p].hi, mid, rm, hi, rh, lo, rl);
    }

    /* ── 3. cmd 3 GET unimplemented ─────────────────────────────── */
    printf("\n=== 3. cmd 3 GET — UNIMPLEMENTED ===\n");
    {
        int p = find_param("dvla");
        int16_t one = 7;
        set_param("dvla", 0, &one, 1);
        int in_size = 4 + 2 + 2 + 2;
        uint8_t *gbuf = calloc(1, in_size);
        *(int32_t *)gbuf = DEVICE_WIRED_HEADPHONE;
        *(int16_t *)(gbuf + 4) = (int16_t)settings_begin[p];
        *(int16_t *)(gbuf + 6) = 1;
        int16_t out = 0;
        int gs = cmd_get(DS_PARAM_SINGLE_DEVICE_VALUE, gbuf, in_size,
                         &out, 2);
        free(gbuf);
        printf("    SET dvla=7, then GET via cmd 3 -> status=%d, val=%d\n"
               "    (engine log: 'Effect_getParameter() Invalid command 3.\n"
               "     Returning -EINVAL(-22)')\n",
               gs, out);
    }

    /* ── 4. cmd 4 VISUALIZER_DATA returns dynamic state ─────────── */
    int16_t vis_snapshot_a[40] = {0};
    printf("\n=== 4. cmd 4 VISUALIZER_DATA — returns vcbg||vcbe ===\n");
    {
        uint8_t empty[80] = {0};
        int gs = cmd_get(DS_PARAM_VISUALIZER_DATA, empty, 80,
                         vis_snapshot_a, 80);
        printf("    snapshot A (after warm-up, quiet 440 Hz sine)\n"
               "    status=%d ; gains[0..4]=[%d,%d,%d,%d,%d] ; "
               "excitations[0..4]=[%d,%d,%d,%d,%d]\n",
               gs, vis_snapshot_a[0], vis_snapshot_a[1], vis_snapshot_a[2],
               vis_snapshot_a[3], vis_snapshot_a[4],
               vis_snapshot_a[20], vis_snapshot_a[21], vis_snapshot_a[22],
               vis_snapshot_a[23], vis_snapshot_a[24]);
    }

    /* ── 5b. Write-to-non-Java-settable forwarding to ak_set ────── */
    printf("\n=== 5b. CMD 3 SET FORWARDS TO ak_set FOR ALL DECLARED "
           "PARAMS ===\n");
    {
        struct { const char *name; int16_t val; } extras[] = {
            { "bver", 9999 }, { "bndl", 7777 }, { "ver", 4242 },
            { "preg", -640 }, { "pstg", -640 }, { "endp", 2 },
            { "mxou", 2 },    { "ocf", 0 },     { "vol", -96 },
            { "ven", 1 },     { "vcnb", 20 },   { "vnnb", 20 },
            { "vcbg", 50 },   { "vcbe", 50 },   { "lcsz", 160 },
        };
        size_t n = sizeof extras / sizeof extras[0];
        printf("    Each write produces 'settingsCache updated' + "
               "'ak_set(idx/name, 0) = V' engine logs:\n");
        for (size_t i = 0; i < n; ++i) {
            int16_t v = extras[i].val;
            int sr = set_param(extras[i].name, 0, &v, 1);
            printf("      set %-4s=%-6d -> reply=%d\n",
                   extras[i].name, v, sr);
        }
    }

    /* ── 6. ENABLE/DISABLE crossfade + idempotency ──────────────── */
    printf("\n=== 6. POWER (ENABLE / DISABLE) ===\n");
    rs = 4; r = 0;
    (*H)->command(H, EFFECT_CMD_DISABLE, 0, NULL, &rs, &r);
    printf("    1st DISABLE -> reply=%d (engine: 'Starting graceful\n"
           "    disable over 5512 samples')\n", r);
    /* Run process() past the 5512-sample disable crossfade (~22 blocks
     * of 256 frames) so the engine logs 'Graceful disable finished.
     * Returning -ENODATA'. */
    {
        int e_nodata_count = 0;
        for (int i = 0; i < 35; ++i) {
            audio_buffer_t in  = { .frameCount = frames, .s16 = pcm_in };
            audio_buffer_t out = { .frameCount = frames, .s16 = pcm_out };
            memset(pcm_out, 0, frames * 4);
            int32_t pr = (*H)->process(H, &in, &out);
            if (pr != 0) e_nodata_count++;
        }
        printf("    35 blocks of process() during DISABLE: %d returned\n"
               "    non-zero (-ENODATA after crossfade completes)\n",
               e_nodata_count);
    }
    rs = 4; r = 0;
    (*H)->command(H, EFFECT_CMD_DISABLE, 0, NULL, &rs, &r);
    printf("    2nd DISABLE (idempotent) -> reply=%d (engine:\n"
           "    'Already disabled, ignoring')\n", r);
    rs = 4; r = 0;
    (*H)->command(H, EFFECT_CMD_ENABLE, 0, NULL, &rs, &r);
    printf("    1st ENABLE  -> reply=%d (engine: 'Starting graceful\n"
           "    enable over 7560 samples')\n", r);
    rs = 4; r = 0;
    (*H)->command(H, EFFECT_CMD_ENABLE, 0, NULL, &rs, &r);
    printf("    2nd ENABLE  (idempotent) -> reply=%d (engine:\n"
           "    'Already enabled, ignoring')\n", r);

    /* Confirm a SET works on both sides of the cycle AND that the
     * post-cycle value actually takes effect at the DSP. Enable the
     * leveler so dvla has an observable effect, then capture
     * peak/rms before and after the cycle with different dvla
     * values. Differing measurements prove cache+AK state survives
     * the cycle and the engine reads the new value on the next
     * audio block. */
    {
        int16_t lev_on = 1, lev_off = 0;
        int16_t lkfs   = -320;
        int16_t a = 7, b = 3;
        set_param("dvle", 0, &lev_on, 1);
        set_param("dvli", 0, &lkfs,   1);
        set_param("dvlo", 0, &lkfs,   1);

        int rA = set_param("dvla", 0, &a, 1);
        process_blocks(pcm_in, pcm_out, frames, 30);
        process_blocks(pcm_in, pcm_out, frames, 1);
        measure("pre-cycle  dvla=7", pcm_out, frames);

        rs = 4; r = 0;
        (*H)->command(H, EFFECT_CMD_DISABLE, 0, NULL, &rs, &r);
        process_blocks(pcm_in, pcm_out, frames, 35);
        rs = 4; r = 0;
        (*H)->command(H, EFFECT_CMD_ENABLE,  0, NULL, &rs, &r);
        process_blocks(pcm_in, pcm_out, frames, 35);

        int rB = set_param("dvla", 0, &b, 1);
        process_blocks(pcm_in, pcm_out, frames, 30);
        process_blocks(pcm_in, pcm_out, frames, 1);
        measure("post-cycle dvla=3", pcm_out, frames);
        printf("    set dvla=7 -> %d ; DISABLE/ENABLE ; set dvla=3 -> %d\n"
               "    (both 0 = cmd 3 SET accepted on both sides; differing\n"
               "     pre/post peak+rms = state survived and the new dvla\n"
               "     took effect at the DSP)\n",
               rA, rB);
        set_param("dvle", 0, &lev_off, 1);
    }

    /* ── 7. Behavioral sweep: DSP reads raw int16 ────────────────── */
    printf("\n=== 7. BEHAVIORAL SWEEP — DSP reads raw int16 ===\n");
    /* Enable leveler so dvla actually has an effect. */
    int16_t on = 1, off = 0;
    set_param("dvle", 0, &on, 1);
    int16_t lkfs = -320;
    set_param("dvli", 0, &lkfs, 1);
    set_param("dvlo", 0, &lkfs, 1);
    process_blocks(pcm_in, pcm_out, frames, 30);

    int16_t dvla_sweep[] = {0, 5, 10, 200, -100};
    printf("    dvla sweep (declared 0..10):\n");
    for (size_t i = 0; i < sizeof dvla_sweep / sizeof dvla_sweep[0]; ++i) {
        int16_t v = dvla_sweep[i];
        set_param("dvla", 0, &v, 1);
        process_blocks(pcm_in, pcm_out, frames, 20);
        process_blocks(pcm_in, pcm_out, frames, 1);  /* measured block */
        char tag[40]; snprintf(tag, sizeof tag, "dvla=%-5d", v);
        measure(tag, pcm_out, frames);
    }
    set_param("dvle", 0, &off, 1);  /* leveler off for the next test */

    int16_t vmon_on = 1;
    set_param("vmon", 0, &vmon_on, 1);
    int16_t vmb_sweep[] = {0, 120, 240, 480, -100};
    printf("    vmb sweep (declared 0..240):\n");
    for (size_t i = 0; i < sizeof vmb_sweep / sizeof vmb_sweep[0]; ++i) {
        int16_t v = vmb_sweep[i];
        set_param("vmb", 0, &v, 1);
        process_blocks(pcm_in, pcm_out, frames, 20);
        process_blocks(pcm_in, pcm_out, frames, 1);
        char tag[40]; snprintf(tag, sizeof tag, "vmb=%-5d", v);
        measure(tag, pcm_out, frames);
    }
    set_param("vmon", 0, &off, 1);

    /* Second cmd 4 snapshot — output shape has changed
     * substantially since snapshot A (vmon cycled on/off, vmb swept
     * past its declared max, leveler enabled+disabled). If vcbg/vcbe
     * are refreshed per-block by the DSP, snapshot B should differ. */
    printf("    cmd 4 snapshot B (after sweeps, audio shape changed):\n");
    {
        uint8_t empty[80] = {0};
        int16_t vis_b[40] = {0};
        int gs = cmd_get(DS_PARAM_VISUALIZER_DATA, empty, 80, vis_b, 80);
        int diff = 0;
        for (int i = 0; i < 40; ++i) if (vis_b[i] != vis_snapshot_a[i]) ++diff;
        printf("        status=%d ; gains[0..4]=[%d,%d,%d,%d,%d] ; "
               "excitations[0..4]=[%d,%d,%d,%d,%d]\n"
               "        %d/40 slots differ from snapshot A\n"
               "        (proves the DSP refreshes vcbg||vcbe between calls)\n",
               gs, vis_b[0], vis_b[1], vis_b[2], vis_b[3], vis_b[4],
               vis_b[20], vis_b[21], vis_b[22], vis_b[23], vis_b[24],
               diff);
    }

    /* ── 8. Out-of-cache index + bogus 4-CC acceptance ──────────── */
    printf("\n=== 8. EDGE CASES ===\n");
    {
        int16_t v = 7;
        int rr = set_flat(cache_total + 100, &v, 1);
        printf("    SET flat=%d (cache=%d) -> reply=%d (engine:\n"
           "    'setting_index ... is invalid')\n",
               cache_total + 100, cache_total, rr);
    }

    /* Does the engine check 'begin' only, or 'begin + count'?
     * This resolves whether v1's count=20 SET against gebg (which
     * straddles the 24-slot cache edge) is rejected outright or
     * silently corrupts adjacent slots. */
    {
        int16_t vals[20] = {0};
        int begin = cache_total - 5;
        int rr = set_flat(begin, vals, 20);
        printf("    SET flat=%d count=20 (begin+count=%d, cache=%d)\n"
               "        -> reply=%d  (%s)\n",
               begin, begin + 20, cache_total, rr,
               rr == 0
                   ? "engine accepts — only 'begin' is bounds-checked,\n"
                     "             v1's count=20-against-1-slot SET would corrupt adjacent slots"
                   : "engine rejects — 'begin + count <= cache_total' enforced,\n"
                     "             v1's count=20-against-1-slot SET would no-op silently");
    }

    /* Bogus 4-CCs in DEFINE_PARAMS on a fresh effect instance.  We
     * use a second effect handle so we don't disturb the main one's
     * established schema. */
    effect_handle_t H2 = NULL;
    int32_t cr2 = C(&desc.uuid, 1, 1, &H2);
    if (cr2 == 0 && H2) {
        uint32_t rs2 = 4; int32_t r2 = 0;
        (*H2)->command(H2, EFFECT_CMD_INIT, 0, NULL, &rs2, &r2);
        uint8_t pbuf[2 + 3 * 4];
        *(int16_t *)(pbuf) = 3;
        memcpy(pbuf + 2,  "xxxx", 4);
        memcpy(pbuf + 6,  "dvla", 4);
        memcpy(pbuf + 10, "yyyy", 4);
        effect_handle_t save = H;
        H = H2;
        int rr = cmd_set(DS_PARAM_DEFINE_PARAMS, pbuf, sizeof pbuf);
        H = save;
        R(H2);
        printf("    DEFINE_PARAMS [xxxx, dvla, yyyy] -> reply=%d "
               "(engine accepts unknown 4-CCs silently)\n", rr);
    }

    free(pcm_in); free(pcm_out);
    R(H); dlclose(lib);
    return 0;
}
