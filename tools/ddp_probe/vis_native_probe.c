/*
 * vis_native_probe.c — Demystify the native (vn*) vs custom (vc*) visualizer.
 *
 * The engine's own help strings (ddp_probe dump docs) name them:
 *   vn* = "Native Visualizer Band ..."  — the engine's intrinsic QMF bands
 *   vc* = "Custom Visualizer Band ..."   — a HOST-CONFIGURABLE resampling
 * and the visq node carries `dcg`/`dce` = "Interpolated visualizer gains/
 * excitations". So vc* is the native data INTERPOLATED onto vcbf, not a
 * separate measurement. ddp_probe #9 saw vnbg/vnbe == vcbg/vcbe only because
 * nobody reconfigured the custom bands away from the native layout.
 *
 * This probe proves the relationship by the experiment ddp_probe never ran:
 *   A. default config — read native (vnnb/vnbf) and custom (vcnb/vcbf) band
 *      layouts + data; show vc* mirrors vn* because the layouts coincide.
 *   B. reconfigure vcbf to a DIFFERENT frequency set (host writes the custom
 *      count+freqs), re-warm, re-read: vc* now DIVERGES from vn*, while vn*
 *      (read-only native) is unchanged. => vc* = interpolate(vn*, vcbf).
 *   C. reconfigure the SAMPLE RATE (cmd 1) and re-read the native GRID: vnnb/
 *      vnbf themselves change — 20 bands @48k/44.1k, 19 @32k — tracking the
 *      engine's rate-indexed .constdata arrays. => the native grid is the
 *      RATE-DERIVED half of vn* (vnnb/vnbf), distinct from the per-block half
 *      (vnbg/vnbe). It can't be host-set; the only lever is the rate.
 *
 * Build/run: `make vis` (see Makefile). Standalone — reuses ddp_probe's
 * proven init handshake + ak_get path, trimmed to the visualizer slots.
 */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <math.h>
#include <dlfcn.h>
#include "audio_effect_defs.h"

#define DS_PARAM_DEFINE_SETTINGS     1
#define DS_PARAM_SINGLE_DEVICE_VALUE 3
#define DS_PARAM_VISUALIZER_DATA     4
#define DS_PARAM_DEFINE_PARAMS       5
#define DS_PARAM_VISUALIZER_ENABLE   7
#define DEVICE_WIRED_HEADPHONE       8

typedef struct { const char *name; int len; } ak_param_t;

/* The canonical 64-name table, DEFINE_PARAMS order (verbatim from ddp_probe
 * G[]; only name+len matter here — refs resolve by position). */
static ak_param_t G[] = {
    {"bver",5},{"bndl",2},{"ocf",1},{"preg",1},{"vdhe",1},{"vspe",1},
    {"dssf",1},{"dvli",1},{"dvlo",1},{"dvle",1},{"dvmc",1},{"dvme",1},
    {"ienb",1},{"iebf",20},{"ieon",1},{"deon",1},{"ngon",1},{"geon",1},
    {"genb",1},{"gebf",20},{"aonb",1},{"aobf",40},{"aobg",42},{"aoon",1},
    {"arnb",1},{"arbf",40},{"plb",1},{"plmd",1},{"ven",1},{"vnnb",1},
    {"vnbf",20},{"vnbg",20},{"vnbe",20},{"vcnb",1},{"vcbf",20},{"vcbg",20},
    {"vcbe",20},{"ver",4},{"pstg",1},{"dhsb",1},{"dhrg",1},{"dssb",1},
    {"dssa",1},{"dvla",1},{"iebt",20},{"iea",1},{"dea",1},{"ded",1},
    {"gebg",20},{"aocc",1},{"arbi",40},{"arbl",40},{"arbh",40},{"arod",1},
    {"artp",1},{"endp",1},{"mxou",1},{"vol",1},{"vmon",1},{"vmb",1},
    {"lcmf",2},{"lcvd",2},{"lcsz",1},{"lcpt",168},
};
#define NPARAM (int)(sizeof(G)/sizeof(G[0]))

/* Real AOSP effect_config_t — 32-byte halves (see setconfig_probe.c). Used by
 * section C to drive cmd 1 SET_CONFIG and change the sample rate. */
typedef struct {
    uint32_t frameCount; void *raw; uint32_t samplingRate; uint32_t channels;
    void *bp_get; void *bp_rel; void *bp_cookie;
    uint8_t format; uint8_t accessMode; uint16_t mask;
} buf_cfg_t;
typedef struct { buf_cfg_t in, out; } cfg_t;
#define CH_STEREO 3
#define FMT_PCM16 1
#define ACC_ACCUM 2

/* RE-derived native grids (the engine's rate-indexed .constdata arrays). 44.1k
 * is `bf` below; 48k/32k here. Section C reads vnnb/vnbf back and compares. */
static const int16_t EXP_48[20] = {47,141,234,328,469,656,844,1031,1313,1688,
    2250,3000,3750,4688,5813,7125,9000,11250,13875,19688};
static const int16_t EXP_32[19] = {31,94,188,313,438,625,875,1125,1375,1750,
    2250,2875,3625,4500,5750,7250,9000,11125,14125};

static effect_handle_t H;
static int settings_begin[NPARAM];

static int find_param(const char *n) {
    for (int i = 0; i < NPARAM; ++i) if (!strcmp(G[i].name, n)) return i;
    return -1;
}

/* ── Engine AK API (same offsets/symbols ddp_probe proves) ───────────── */
typedef int (*ak_get_fn)(void *, uint32_t, int);
typedef int (*ak_set_fn)(void *, uint32_t, int, int);
static ak_get_fn ak_get;
static ak_set_fn ak_set;
static void *AK;
static uint32_t *AK_REF;

static void ak_attach(void) {
    void *pDs1ap = *(void **)((char *)H + 0x44);
    AK     = *(void **)pDs1ap;
    AK_REF = *(uint32_t **)((char *)H + 0xb4);
}
static uint32_t ak_ref(const char *n) { int p = find_param(n); return p < 0 ? 0 : AK_REF[p]; }
static int akv(const char *n, int e)  { return ak_get(AK, ak_ref(n), e); }

/* ── cmd SET / DEFINE plumbing (trimmed from ddp_probe) ──────────────── */
static int cmd_set(int cmd, const void *val, int vsize) {
    int total = sizeof(effect_param_t) + 4 + vsize;
    uint8_t *buf = calloc(1, total);
    effect_param_t *ep = (effect_param_t *)buf;
    ep->psize = 4; ep->vsize = vsize;
    *(int32_t *)(buf + sizeof(effect_param_t)) = cmd;
    memcpy(buf + sizeof(effect_param_t) + 4, val, vsize);
    uint32_t rs = 4; int32_t reply = -1;
    (*H)->command(H, EFFECT_CMD_SET_PARAM, total, buf, &rs, &reply);
    free(buf);
    return reply;
}
static int set_flat(int flat, const int16_t *vals, int count) {
    int vsize = 4 + 2 + 2 + count * 2;
    uint8_t *buf = calloc(1, vsize);
    *(int32_t *)buf = DEVICE_WIRED_HEADPHONE;
    *(int16_t *)(buf + 4) = (int16_t)flat;
    *(int16_t *)(buf + 6) = (int16_t)count;
    memcpy(buf + 8, vals, count * 2);
    int r = cmd_set(DS_PARAM_SINGLE_DEVICE_VALUE, buf, vsize);
    free(buf);
    return r;
}
static int set_param(const char *name, int off, const int16_t *v, int c) {
    int p = find_param(name);
    if (p < 0 || settings_begin[p] < 0) return -998;
    return set_flat(settings_begin[p] + off, v, c);
}
static void define_params(void) {
    uint8_t *buf = calloc(1, 2 + NPARAM * 4);
    *(int16_t *)buf = (int16_t)NPARAM;
    for (int i = 0; i < NPARAM; ++i)
        memcpy(buf + 2 + i * 4, G[i].name, strlen(G[i].name));
    cmd_set(DS_PARAM_DEFINE_PARAMS, buf, 2 + NPARAM * 4);
    free(buf);
}
static int define_settings_all(void) {
    int total = 0;
    for (int i = 0; i < NPARAM; ++i) total += G[i].len;
    uint8_t *buf = calloc(1, 2 + total * 3);
    *(int16_t *)buf = (int16_t)total;
    int pos = 2, flat = 0;
    for (int i = 0; i < NPARAM; ++i) {
        settings_begin[i] = flat;
        for (int e = 0; e < G[i].len; ++e) {
            buf[pos++] = (uint8_t)i;
            *(int16_t *)(buf + pos) = (int16_t)e; pos += 2; flat++;
        }
    }
    cmd_set(DS_PARAM_DEFINE_SETTINGS, buf, 2 + total * 3);
    free(buf);
    return total;
}

/* cmd 1 SET_CONFIG — change the sample rate (stereo/PCM16/ACCUM). Rebuilds the
 * graph via Ds1ap::New; the engine re-selects the native grid for the new rate.
 * Gated to {32000,44100,48000} (see setconfig_probe.c). */
static void send_config(uint32_t rate) {
    cfg_t c; memset(&c, 0, sizeof c);
    c.in.frameCount = c.out.frameCount = 256;
    c.in.samplingRate = c.out.samplingRate = rate;
    c.in.channels = c.out.channels = CH_STEREO;
    c.in.format = c.out.format = FMT_PCM16;
    c.in.accessMode = c.out.accessMode = ACC_ACCUM;
    uint32_t rs = 4; int32_t reply = 0;
    (*H)->command(H, EFFECT_CMD_SET_CONFIG, 64, &c, &rs, &reply);
}

/* ── audio ───────────────────────────────────────────────────────────── */
static void fill_mix(int16_t *pcm, int frames, double rate) {
    /* a 3-tone mix (low/mid/high) so the band profile is non-flat and any
     * frequency remap is visible across the spectrum. */
    for (int i = 0; i < frames; ++i) {
        double t = i / rate;
        double s = 9000*sin(2*M_PI*180*t) + 7000*sin(2*M_PI*1500*t)
                 + 6000*sin(2*M_PI*9000*t);
        pcm[i*2] = pcm[i*2+1] = (int16_t)s;
    }
}
static void warm(int16_t *in, int16_t *out, int frames, int n) {
    for (int i = 0; i < n; ++i) {
        fill_mix(in, frames, 44100.0);
        audio_buffer_t ib = { .frameCount = frames, .s16 = in };
        audio_buffer_t ob = { .frameCount = frames, .s16 = out };
        memset(out, 0, frames * 4);
        (*H)->process(H, &ib, &ob);
    }
}

/* print one band layout + its gain/excitation, native vs custom side by side */
static int diffcount(const char *a, const char *b, int n) {
    int d = 0;
    for (int e = 0; e < n; e++) if (akv(a, e) != akv(b, e)) d++;
    return d;
}
static void dump_row(const char *label, const char *p, int n) {
    printf("    %-10s", label);
    for (int e = 0; e < n; e++) printf(" %6d", akv(p, e));
    printf("\n");
}

int main(int argc, char *argv[]) {
    setbuf(stdout, NULL); setbuf(stderr, NULL);
    if (argc < 2) { fprintf(stderr, "usage: %s <libdseffect.so>\n", argv[0]); return 1; }
    void *lib = dlopen(argv[1], RTLD_NOW);
    if (!lib) { fprintf(stderr, "dlopen: %s\n", dlerror()); return 1; }
    EffectQueryNumberEffects_t Q = dlsym(lib, "EffectQueryNumberEffects");
    EffectQueryEffect_t       QE = dlsym(lib, "EffectQueryEffect");
    EffectCreate_t            C  = dlsym(lib, "EffectCreate");
    ak_get = (ak_get_fn) dlsym(lib, "ak_get");
    ak_set = (ak_set_fn) dlsym(lib, "ak_set");

    uint32_t ne = 0; Q(&ne);
    effect_descriptor_t desc; QE(0, &desc);
    if (C(&desc.uuid, 0, 0, &H) || !H) { fprintf(stderr, "EffectCreate failed\n"); return 1; }
    uint32_t rs = 4; int32_t r = 0;
    (*H)->command(H, EFFECT_CMD_INIT, 0, NULL, &rs, &r);

    /* init handshake — constants first, then settings, then attach AK */
    define_params();
    define_settings_all();
    ak_attach();
    int16_t v20 = 20;
    set_param("genb", 0, &v20, 1); set_param("ienb", 0, &v20, 1);
    set_param("aonb", 0, &v20, 1);
    int16_t bf[20] = {43,129,215,301,431,603,775,947,1206,1550,2067,2756,
                      3618,4651,5685,7063,8958,11025,13781,18777};
    set_param("gebf", 0, bf, 20); set_param("iebf", 0, bf, 20);
    int32_t vis_on = 1;
    cmd_set(DS_PARAM_VISUALIZER_ENABLE, &vis_on, 4);
    int16_t one = 1; set_param("ven", 0, &one, 1);   /* AK-level visualizer enable */

    (*H)->command(H, EFFECT_CMD_ENABLE, 0, NULL, &rs, &r);

    int frames = 256;
    int16_t *in = calloc(frames * 2, 2), *out = calloc(frames * 2, 2);
    warm(in, out, frames, 60);

    int nnb = akv("vnnb", 0), cnb = akv("vcnb", 0);
    printf("=== A. DEFAULT CONFIG — native vs custom band layout ===\n");
    printf("    vnnb (native count)   = %d   [read-only: engine's intrinsic bands]\n", nnb);
    printf("    vcnb (custom count)   = %d   [writable: host-configured resampling]\n", cnb);
    int n = nnb > 0 && nnb <= 20 ? nnb : 20;
    dump_row("vnbf nat-f", "vnbf", n);
    dump_row("vcbf cus-f", "vcbf", n);
    printf("    native vs custom center freqs differ in %d/%d bands\n",
           diffcount("vnbf", "vcbf", n), n);
    dump_row("vnbg nat-g", "vnbg", n);
    dump_row("vcbg cus-g", "vcbg", n);
    dump_row("vnbe nat-e", "vnbe", n);
    dump_row("vcbe cus-e", "vcbe", n);
    printf("    => vnbg==vcbg in %d/%d, vnbe==vcbe in %d/%d  "
           "(mirror: custom layout == native layout)\n",
           n - diffcount("vnbg","vcbg",n), n, n - diffcount("vnbe","vcbe",n), n);

    /* ── B. reconfigure custom bands to a DIFFERENT frequency set ─────── */
    printf("\n=== B. RECONFIGURE vcbf — custom bands remapped ===\n");
    /* Save the native data (read-only; it must NOT move under us). */
    int natg[20], nate[20];
    for (int e = 0; e < n; e++) { natg[e] = akv("vnbg", e); nate[e] = akv("vnbe", e); }
    /* A clearly different, monotonically-increasing layout: a linear ramp
     * 120..2400 Hz (vs the native log spread to ~19 kHz). Interpolating the
     * native curve onto these must produce a different profile. */
    int16_t cf[20];
    for (int e = 0; e < 20; e++) cf[e] = (int16_t)(120 + e * 120);
    int16_t cnt = 20;
    set_param("vcnb", 0, &cnt, 1);          /* custom count */
    set_param("vcbf", 0, cf, 20);           /* custom freqs = the commit (vcbf_preupdate) */
    /* "take effect ... when ven is set to ON" — re-latch ven, then re-warm. */
    int16_t zero = 0;
    set_param("ven", 0, &zero, 1); warm(in, out, frames, 5);
    set_param("ven", 0, &one, 1);  warm(in, out, frames, 60);

    dump_row("vcbf new-f", "vcbf", n);
    dump_row("vnbg nat-g", "vnbg", n);   /* unchanged native ground truth */
    dump_row("vcbg cus-g", "vcbg", n);   /* interpolated onto new freqs */
    dump_row("vnbe nat-e", "vnbe", n);
    dump_row("vcbe cus-e", "vcbe", n);

    /* max abs deviation from the pre-remap native snapshot. Native should
     * drift only a few LSB (smoother jitter from streaming audio); custom
     * should swing by hundreds (whole bands relocated by the freq remap). */
    int nat_dev = 0, cus_dev = 0;
    for (int e = 0; e < n; e++) {
        int dg = abs(akv("vnbg", e) - natg[e]), de = abs(akv("vnbe", e) - nate[e]);
        if (dg > nat_dev) nat_dev = dg; if (de > nat_dev) nat_dev = de;
        int cg = abs(akv("vcbg", e) - natg[e]), ce = abs(akv("vcbe", e) - nate[e]);
        if (cg > cus_dev) cus_dev = cg; if (ce > cus_dev) cus_dev = ce;
    }
    printf("\n    native vnbg/vnbe vs pre-remap snapshot: max |delta| = %-4d "
           "(~noise: native is the fixed ground truth)\n", nat_dev);
    printf("    custom vcbg/vcbe vs that same snapshot: max |delta| = %-4d "
           "(large: custom is a remap of native, not a copy)\n", cus_dev);
    printf("    vcbg==vnbg now %d/%d, vcbe==vnbe now %d/%d "
           "(mirror BROKEN by the custom remap)\n",
           n - diffcount("vnbg","vcbg",n), n, n - diffcount("vnbe","vcbe",n), n);

    /* ── C. change the SAMPLE RATE — the native grid itself moves ──────── */
    printf("\n=== C. RECONFIGURE RATE — native grid is rate-derived ===\n");
    printf("    (fresh handle per rate; cmd 1 SET_CONFIG selects the native array)\n");
    struct { uint32_t hz; const int16_t *exp; int n; } sweep[] = {
        {48000, EXP_48, 20}, {44100, bf, 20}, {32000, EXP_32, 19} };
    for (int s = 0; s < 3; s++) {
        C(&desc.uuid, 200 + s, 200 + s, &H);
        (*H)->command(H, EFFECT_CMD_INIT, 0, NULL, &rs, &r);
        send_config(sweep[s].hz);                  /* rebuild graph at this rate */
        define_params(); define_settings_all(); ak_attach();
        set_param("genb", 0, &v20, 1); set_param("ienb", 0, &v20, 1);
        set_param("gebf", 0, bf, 20); set_param("iebf", 0, bf, 20);
        cmd_set(DS_PARAM_VISUALIZER_ENABLE, &vis_on, 4);
        set_param("ven", 0, &one, 1);
        (*H)->command(H, EFFECT_CMD_ENABLE, 0, NULL, &rs, &r);
        warm(in, out, frames, 60);
        int nb = akv("vnnb", 0), fmatch = 1;
        printf("    %5u Hz: vnnb=%2d (expect %2d)%s  vnbf:", sweep[s].hz, nb,
               sweep[s].n, nb == sweep[s].n ? "" : "  !!COUNT");
        for (int e = 0; e < sweep[s].n; e++) {
            int v = akv("vnbf", e); printf(" %d", v);
            if (v != sweep[s].exp[e]) fmatch = 0;
        }
        printf("   [%s]\n", fmatch ? "matches .constdata array" : "DIFFERS !!");
    }
    printf("    => native vnnb/vnbf track the rate (20/20/19 bands @48k/44.1k/32k);\n"
           "       only the sample rate moves them — they're read-only otherwise.\n");

    printf("\n=== VERDICT ===\n");
    printf("    vn* = engine's NATIVE filterbank visualizer (read-only ground truth),\n");
    printf("          in two halves: vnnb/vnbf = the RATE-DERIVED band grid (A,C) and\n");
    printf("          vnbg/vnbe = the per-block measurements taken on it.\n");
    printf("    vc* = that native data INTERPOLATED onto host-set vcnb/vcbf (vc==vn\n");
    printf("          only when the custom layout matches native, B). Not redundant —\n");
    printf("          vn* is the zero-config source; vc* is the configurable view.\n");
    _Exit(0);
}
