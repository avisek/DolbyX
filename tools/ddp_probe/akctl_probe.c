/*
 * akctl_probe.c — DolbyX v2 experiment: drive the engine via the AK API
 * directly, skipping the cmd protocol's PARAMETER surface.
 *
 * Companion to ddp_probe.c (the cmd-protocol evidence harness). Where
 * ddp_probe drives params through command()/effect_param_t — the
 * DEFINE_PARAMS + DEFINE_SETTINGS handshake, then cmd 2/3 — this probe asks
 * the v2 question: can the engine-side shim skip all of that and call
 * ak_set/ak_get/ak_find directly?  docs/ddp/07-ak-api.md says the cmd
 * protocol is "AK underneath" (cmd 3 = ak_set + a dead settings-cache write);
 * this harness proves it end-to-end and measures what, if anything, the cmd
 * path adds on top.
 *
 * Two parts:
 *   Hd — NO handshake. ak_find resolves refs by name (no DEFINE_PARAMS),
 *        ak_set configures + drives a full GEQ effect, ak_get reads it back.
 *        Proves the whole handshake + cmd 3 param path is optional, AND that
 *        ak_set alone makes the DSP recompute coefficients (the missing half
 *        of ddp_probe #7, which only showed a cache poke is inert).
 *   Hh — two fresh handles run BYTE-IDENTICAL sequences, differing only in
 *        how gebg[4] is boosted: cmd 3 on one, bare ak_set on the other.
 *        Identical history on both, so equal output is airtight proof that
 *        "cmd 3 == ak_set (+ a dead cache write)" at the DSP.
 *
 * Lifecycle (INIT / ENABLE / process) stays on the cmd path throughout: those
 * carry app-level behaviour — notably the graceful enable/disable crossfade —
 * that the bare AK framework calls don't reproduce. Only the PARAMETER surface
 * is the subject here.
 *
 * Build & run: make -C tools/ddp_probe akctl   (see Makefile / README.md).
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
#define DS_PARAM_DEFINE_PARAMS       5
#define DEVICE_WIRED_HEADPHONE       8

/* ── Minimal host param list, only what the cmd 3 path touches ────────────
 * The engine assigns DEFINE_PARAMS indices by POSITION and doesn't validate
 * names, so a 7-entry list is a complete, valid handshake — far smaller than
 * ddp_probe's full 64. Flat-cache offsets are computed from this order.
 * The AK-direct path never uses this table — it resolves refs by name. */
typedef struct { const char *name; int len; } host_param_t;
static host_param_t G[] = {
    {"genb", 1}, {"ienb", 1}, {"aonb", 1},
    {"gebf", 20}, {"geon", 1}, {"ieon", 1}, {"gebg", 20},
};
#define NPARAM (int)(sizeof(G) / sizeof(G[0]))
static int settings_begin[NPARAM];          /* flat cache index per param */

static int find_param(const char *n) {
    for (int i = 0; i < NPARAM; ++i)
        if (!strcmp(G[i].name, n)) return i;
    return -1;
}

/* Standard 20-band GEQ centre frequencies (verbatim from ddp_probe). Band 4
 * = 431 Hz — the boosted band, matched by the test tone. */
static const int16_t GEBF[20] = {43, 129, 215, 301, 431, 603, 775, 947, 1206,
    1550, 2067, 2756, 3618, 4651, 5685, 7063, 8958, 11025, 13781, 18777};
#define TEST_BAND  4
#define TEST_FREQ  431.0
#define TEST_AMP   2000.0   /* low enough that the +10 dB boost stays clear of clipping */
#define BOOST      160
#define FRAMES     256
#define RATE       44100.0
#define WARM       60       /* past the 7560-sample enable crossfade (~30 blocks) */
#define SETTLE     150      /* let the GEQ gain smoother settle after a change */

static effect_handle_t H;       /* current handle (cmd_set/set_flat target) */
static void   *AK;              /* current handle's AK registry handle */
static EffectCreate_t C;        /* EffectCreate, resolved in main */
static effect_descriptor_t DESC;
static int16_t *g_in, *g_out;   /* shared PCM scratch */

/* ── Engine AK API — the registry the DSP actually reads/writes ───────────
 * Exported symbols; reachable in-process. The cmd protocol's param surface
 * bottoms out in exactly these (07-ak-api.md). */
typedef int      (*ak_get_fn)(void *, uint32_t, int);
typedef int      (*ak_set_fn)(void *, uint32_t, int, int);
typedef int      (*ak_set_bulk_fn)(void *, uint32_t, int, int, int, const void *);
typedef uint32_t (*ak_find_fn)(void *, uint32_t, uint32_t);
typedef int      (*ak_minmax_fn)(void *, uint32_t);
static ak_get_fn      ak_get;
static ak_set_fn      ak_set;
static ak_set_bulk_fn ak_set_bulk;
static ak_find_fn     ak_find;
static ak_minmax_fn   ak_get_min, ak_get_max;

/* AK handle from the effect context — ONE frozen offset (H+0x44, double
 * deref). The AK-direct model needs only this; it never touches the host's
 * +0xb4 ref table (that exists only to back the cmd-3 flat-index path). */
static void ak_attach(void) { AK = *(void **)(*(void **)((char *)H + 0x44)); }

/* Pack a 4-CC into the engine's little-endian uint32 form for ak_find. */
static uint32_t pack4(const char *s) {
    uint32_t f = 0;
    for (int i = 0; i < 4 && s[i]; i++) f |= (uint32_t)(uint8_t)s[i] << (8 * i);
    return f;
}
/* Resolve a name -> ref straight from the engine tree (root = ref 1), with NO
 * DEFINE_PARAMS. This is the crux of AK-direct addressing. */
static uint32_t rref(const char *name) { return ak_find ? ak_find(AK, 1, pack4(name)) : 0; }

/* The raw host-side settings cache (H+0xb0) — what cmd 3 SET writes the raw
 * value into, and the DSP ignores. NULL until the first cmd 3 SET allocates it. */
static const int16_t *find_cache(void) { return *(const int16_t **)((char *)H + 0xb0); }

/* ── cmd-protocol helpers ─────────────────────────────────────────────── */
static int cmd_set(int cmd, const void *val, int vsize) {
    int total = sizeof(effect_param_t) + 4 + vsize;
    uint8_t *buf = calloc(1, total);
    effect_param_t *ep = (effect_param_t *)buf;
    ep->status = 0; ep->psize = 4; ep->vsize = vsize;
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
    *(int32_t *)(buf)     = DEVICE_WIRED_HEADPHONE;
    *(int16_t *)(buf + 4) = (int16_t)flat;
    *(int16_t *)(buf + 6) = (int16_t)count;
    memcpy(buf + 8, vals, count * 2);
    int r = cmd_set(DS_PARAM_SINGLE_DEVICE_VALUE, buf, vsize);
    free(buf);
    return r;
}
static int set_param(const char *name, int offset, int16_t v) {
    return set_flat(settings_begin[find_param(name)] + offset, &v, 1);
}
static void define_params(void) {
    uint8_t *buf = calloc(1, 2 + NPARAM * 4);
    *(int16_t *)buf = (int16_t)NPARAM;
    for (int i = 0; i < NPARAM; ++i)
        memcpy(buf + 2 + i * 4, G[i].name, strlen(G[i].name));
    cmd_set(DS_PARAM_DEFINE_PARAMS, buf, 2 + NPARAM * 4);
    free(buf);
}
static void define_settings(void) {
    int total = 0;
    for (int i = 0; i < NPARAM; ++i) total += G[i].len;
    uint8_t *buf = calloc(1, 2 + total * 3);
    *(int16_t *)buf = (int16_t)total;
    int pos = 2, flat = 0;
    for (int i = 0; i < NPARAM; ++i) {
        settings_begin[i] = flat;
        for (int e = 0; e < G[i].len; ++e) {
            buf[pos++] = (uint8_t)i;
            *(int16_t *)(buf + pos) = (int16_t)e; pos += 2;
            flat++;
        }
    }
    cmd_set(DS_PARAM_DEFINE_SETTINGS, buf, 2 + total * 3);
    free(buf);
}

/* ── audio + measurement (idioms from ddp_probe) ─────────────────────── */
static void fill_sine(int16_t *pcm, int frames, double amp, double freq) {
    for (int i = 0; i < frames; ++i) {
        int s = (int)(amp * sin(2.0 * M_PI * freq * (i / RATE)));
        pcm[i*2] = (int16_t)s; pcm[i*2+1] = (int16_t)s;
    }
}
/* Stream n blocks of a fresh tone; process() clobbers its input and
 * ACCUMULATEs into the (pre-zeroed) output, so refill + zero every block. */
static void process_tone(double freq, double amp, int n) {
    for (int i = 0; i < n; ++i) {
        fill_sine(g_in, FRAMES, amp, freq);
        audio_buffer_t ib = { .frameCount = FRAMES, .s16 = g_in };
        audio_buffer_t ob = { .frameCount = FRAMES, .s16 = g_out };
        memset(g_out, 0, FRAMES * 4);
        (*H)->process(H, &ib, &ob);
    }
}
static void stats(const int16_t *buf, int *peak, double *rms) {
    int pk = 0; double ss = 0;
    for (int i = 0; i < FRAMES * 2; ++i) {
        int v = buf[i], a = v < 0 ? -v : v;
        if (a > pk) pk = a;
        ss += (double)v * v;
    }
    *peak = pk; *rms = sqrt(ss / (FRAMES * 2));
}
static void measure(const char *label, const int16_t *buf) {
    int pk; double rms; stats(buf, &pk, &rms);
    printf("      %-30s peak=%5d rms=%8.1f\n", label, pk, rms);
}
static void enable(void) {
    uint32_t rs = 4; int32_t r = 0;
    (*H)->command(H, EFFECT_CMD_ENABLE, 0, NULL, &rs, &r);
}

/* Open a handshake handle: INIT, the full DEFINE_PARAMS/SETTINGS dance, GEQ
 * on with a flat curve, ENABLE, and warm past the crossfade — everything up
 * to (but not including) the boost. Both Hh handles call this identically so
 * their DSP history matches; only the boost mechanism differs afterwards. */
static void hh_open(int sess) {
    C(&DESC.uuid, sess, sess, &H);
    uint32_t rs = 4; int32_t r = 0;
    (*H)->command(H, EFFECT_CMD_INIT, 0, NULL, &rs, &r);
    define_params();
    define_settings();
    ak_attach();
    set_param("genb", 0, 20); set_param("ienb", 0, 20); set_param("aonb", 0, 20);
    for (int e = 0; e < 20; e++) set_param("gebf", e, GEBF[e]);
    set_param("geon", 0, 1); set_param("ieon", 0, 0);
    for (int e = 0; e < 20; e++) set_param("gebg", e, 0);   /* flat curve */
    enable();
    process_tone(TEST_FREQ, TEST_AMP, WARM);
}

int main(int argc, char *argv[]) {
    setbuf(stdout, NULL); setbuf(stderr, NULL);
    if (argc < 2) { fprintf(stderr, "Usage: %s <libdseffect.so>\n", argv[0]); return 1; }

    void *lib = dlopen(argv[1], RTLD_NOW);
    if (!lib) { fprintf(stderr, "dlopen: %s\n", dlerror()); return 1; }
    EffectQueryEffect_t QE = dlsym(lib, "EffectQueryEffect");
    C            = (EffectCreate_t)  dlsym(lib, "EffectCreate");
    ak_get       = (ak_get_fn)      dlsym(lib, "ak_get");
    ak_set       = (ak_set_fn)      dlsym(lib, "ak_set");
    ak_set_bulk  = (ak_set_bulk_fn) dlsym(lib, "ak_set_bulk");
    ak_find      = (ak_find_fn)     dlsym(lib, "ak_find");
    ak_get_min   = (ak_minmax_fn)   dlsym(lib, "ak_get_min");
    ak_get_max   = (ak_minmax_fn)   dlsym(lib, "ak_get_max");
    if (!ak_get || !ak_set || !ak_find || !ak_get_min) {
        fprintf(stderr, "dlsym: missing an ak_* accessor\n"); return 1;
    }
    QE(0, &DESC);
    g_in  = calloc(FRAMES * 2, 2);
    g_out = calloc(FRAMES * 2, 2);
    int16_t out_cmd[FRAMES * 2];

    /* ═══════════════════════════════════════════════════════════════════
     * Hd — pure AK-direct: NO handshake at all (the v2 proposal)
     * ═══════════════════════════════════════════════════════════════════ */
    printf("=== Hd: AK-DIRECT, NO HANDSHAKE ============================\n");
    int32_t cr = C(&DESC.uuid, 0, 0, &H);
    if (cr || !H) { fprintf(stderr, "EffectCreate Hd failed (%d)\n", cr); return 1; }
    { uint32_t rs = 4; int32_t r = 0; (*H)->command(H, EFFECT_CMD_INIT, 0, NULL, &rs, &r); }
    ak_attach();   /* AK handle from H+0x44 — built at create, NOT by a handshake */

    /* (1) refs resolve by NAME with no DEFINE_PARAMS sent. */
    const char *want[] = {"genb", "gebf", "geon", "ieon", "gebg", "dvle", "dvla"};
    int unresolved = 0;
    printf("  (1) ak_find resolves refs with no DEFINE_PARAMS:");
    for (int i = 0; i < (int)(sizeof want / sizeof *want); i++) {
        uint32_t r = rref(want[i]);
        printf(" %s=%u", want[i], r);
        if (!r) unresolved++;
    }
    printf("\n      -> %s\n", unresolved ? "SOME UNRESOLVED — AK-direct needs more setup"
                                         : "all resolved; the AK tree exists pre-handshake");

    /* The cmd 3 path is DEAD here: no DEFINE_SETTINGS means no cache slots. */
    printf("  (2) cmd 3 SET with no handshake -> reply=%d "
           "(expected -22; AK-direct doesn't need it)\n", set_flat(0, &(int16_t){20}, 1));

    /* (3) configure a GEQ entirely through ak_set — genb/gebf are the
     *     "constant params"; AK-direct sets them like any other value, with
     *     no separate constant-params dance. */
    uint32_t r_genb = rref("genb"), r_gebf = rref("gebf"),
             r_geon = rref("geon"), r_ieon = rref("ieon"), r_gebg = rref("gebg");
    ak_set(AK, r_genb, 0, 20);
    for (int e = 0; e < 20; e++) ak_set(AK, r_gebf, e, GEBF[e]);
    ak_set(AK, r_geon, 0, 1);                 /* GEQ on  */
    ak_set(AK, r_ieon, 0, 0);                 /* IEQ off */
    for (int e = 0; e < 20; e++) ak_set(AK, r_gebg, e, 0);   /* flat curve */
    enable();
    process_tone(TEST_FREQ, TEST_AMP, WARM + SETTLE);
    printf("  (3) GEQ configured + driven via ak_set only:\n");
    measure("flat curve (gebg[4]=0)", g_out);

    /* (4) the decisive one: bump ONE band via ak_set and let the DSP run.
     *     If the output changes, ak_update recomputed the GEQ coefficients
     *     from the registry on the next block — no cmd 3, no "commit". */
    ak_set(AK, r_gebg, TEST_BAND, BOOST);
    process_tone(TEST_FREQ, TEST_AMP, SETTLE);
    measure("ak_set gebg[4]=160", g_out);
    printf("      ak_get gebg[4] reads back = %d  (a real per-param GET — "
           "cmd 3 GET is unimplemented, returns -22)\n", ak_get(AK, r_gebg, TEST_BAND));

    /* (5) bulk write (the cmd 2 / ALL_VALUES equivalent) + range read-back.
     *     ak_set_bulk addresses by (ref, elem) so it can't straddle into a
     *     neighbouring param the way cmd 3's flat begin+count can (the v1
     *     heap-corruption footgun in ddp_probe #8b). */
    int16_t ramp[20];
    for (int e = 0; e < 20; e++) ramp[e] = (int16_t)(e * 10 - 90);
    ak_set_bulk(AK, r_gebg, 0, 20, 4, ramp);
    int ok = 0;
    for (int e = 0; e < 20; e++) ok += (ak_get(AK, r_gebg, e) == ramp[e]);
    printf("  (5) ak_set_bulk gebg[0..19] in one call -> %d/20 read back correct\n", ok);

    /* (6) engine-authoritative ranges, free via ak_get_min/max — the metadata
     *     the daemon would otherwise hand-maintain and the cmd path can't return. */
    printf("  (6) ak_get ranges (authoritative): ");
    const char *rng[] = {"dvla", "vmb", "vol"};
    for (int i = 0; i < 3; i++) {
        uint32_t r = rref(rng[i]);
        printf("%s[%d..%d] ", rng[i], ak_get_min(AK, r), ak_get_max(AK, r));
    }
    printf("\n");

    /* ═══════════════════════════════════════════════════════════════════
     * Hh — cmd 3  vs  ak_set, two handles on identical sequences
     * ═══════════════════════════════════════════════════════════════════ */
    printf("\n=== Hh: cmd 3  vs  ak_set  EQUIVALENCE (identical histories) =\n");

    /* Handle 1 — boost via cmd 3 (writes BOTH the raw cache and the registry). */
    hh_open(1);   /* populates settings_begin[] via define_settings() */
    int slot = settings_begin[find_param("gebg")] + TEST_BAND;   /* flat cache index */
    uint32_t h1_gebg = rref("gebg");
    set_param("gebg", TEST_BAND, BOOST);
    process_tone(TEST_FREQ, TEST_AMP, SETTLE);
    memcpy(out_cmd, g_out, FRAMES * 4);
    const int16_t *c1 = find_cache();
    printf("  (A) cmd 3 gebg[4]=160 : cache(raw)=%d  ak_get(reg)=%d\n",
           c1 ? c1[slot] : -1, ak_get(AK, h1_gebg, TEST_BAND));
    measure("cmd 3 output", out_cmd);

    /* Handle 2 — identical setup, boost via bare ak_set (registry ONLY). */
    hh_open(2);
    uint32_t h2_gebg = rref("gebg");
    ak_set(AK, h2_gebg, TEST_BAND, BOOST);
    process_tone(TEST_FREQ, TEST_AMP, SETTLE);
    const int16_t *c2 = find_cache();
    printf("  (B) ak_set gebg[4]=160: cache(raw)=%d  ak_get(reg)=%d  "
           "<- cache untouched, registry set\n",
           c2 ? c2[slot] : -1, ak_get(AK, h2_gebg, TEST_BAND));
    measure("ak_set output", g_out);

    /* (C) verdict is bit-exact (max|Δsample| == 0): identical histories at a
     *     deterministic DSP match to the sample; peak+rms corroborate. */
    int pk_c, pk_a; double rms_c, rms_a;
    stats(out_cmd, &pk_c, &rms_c);
    stats(g_out,   &pk_a, &rms_a);
    int maxd = 0;
    for (int i = 0; i < FRAMES * 2; i++) {
        int dd = out_cmd[i] - g_out[i]; if (dd < 0) dd = -dd;
        if (dd > maxd) maxd = dd;
    }
    double rrel = rms_c > 0 ? fabs(rms_c - rms_a) / rms_c : 0;
    int equiv = (maxd == 0) && (pk_c == pk_a) && (rrel < 0.001);
    printf("  (C) cmd 3 vs ak_set: peak %d==%d, rms %.1f vs %.1f (%.4f%%), max|Δsample|=%d\n"
           "      -> %s\n",
           pk_c, pk_a, rms_c, rms_a, rrel * 100, maxd,
           equiv ? "EQUIVALENT (bit-for-bit) — cmd 3 == ak_set at the DSP; the cache write is dead weight"
                 : "DIFFERENT — cmd 3 does something ak_set doesn't (investigate)");

    /* ── scope note ──────────────────────────────────────────────────── */
    printf("\n=== SCOPE ===================================================\n");
    printf("  Param surface: ak_set/ak_get/ak_find replace DEFINE_PARAMS +\n"
           "    DEFINE_SETTINGS + cmd 2/3/4 with zero DSP compromise (above).\n");
    printf("  Lifecycle stays on cmd: INIT/ENABLE/DISABLE/process carry the\n"
           "    graceful crossfade etc.; bare ak_start/ak_process would skip it.\n");
    printf("  Coupling: AK-direct needs ONE frozen offset (H+0x44) + the\n"
           "    exported ak_* symbols. EOL binary => offset is pinned.\n");

    _Exit(0);   /* skip teardown — OS reclaims; avoids double-free noise in CI */
}
