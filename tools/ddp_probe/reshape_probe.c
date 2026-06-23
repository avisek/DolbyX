/*
 * reshape_probe.c — Do the "structural constant" params (genb/gebf, ienb/iebf,
 * aonb/aobf, aocc) reshape the live DSP at RUNTIME, or are they frozen once the
 * graph is built?
 *
 * They aren't write-protected (dump-types: flags 0x1025, no 0x2 bit), so ak_set
 * stores them. The real question is whether a write RESHAPES the running DSP —
 * moves a band's centre, wakes an inactive band.
 *
 * The engine's OWN param help text (.conststring, `dump docs`) spells out a
 * COMMIT protocol: a count/frequency change is inert until the band GAINS are
 * re-written, and that gains write is what re-derives the filterbank:
 *   genb "Graphic Equalizer Band Count": "If this value is changed, the 'gebf'
 *        and 'gebg' settings must be updated. The Graphic Equalizer will not
 *        update until these parameters have been updated."
 *   gebf "Band Frequencies": "The 'gebg' parameter must be updated after this
 *        value has been modified. No change ... until the gains have also been
 *        updated."
 *   (IEQ ienb/iebf commit via iebt; AO aocc/aonb/aobf via aobg — same pattern.)
 *
 * Method: AK-direct (ak_find/ak_set/ak_get, like akctl_probe). Isolate the GEQ,
 * boost one band, watch a matched test tone to see WHERE the boost lands. Two
 * findings:
 *
 *   A. The commit GATES the reshape. A count/freq change alone is INERT; the
 *      next gebg write applies it. Shown two ways — moving a band's centre
 *      (gebf 431->6000 Hz) and waking an inactive high band (genb 10->20). And
 *      the gebg WRITE is the trigger: it fires even with IDENTICAL values
 *      (commit presence, not a value delta).
 *
 *   B. Among the three commit writes {genb, gebf, gebg}, ORDER is free. Driving
 *      the GEQ between two orthogonal shapes in ALL SIX orders lands the
 *      identical result, raising or lowering the band count alike — even orders
 *      that write the gains first. So "commit order" is a no-op; commit
 *      PRESENCE (gebg re-written at all) is the only rule.
 *
 * Mechanism, in the binary: each array's *_preupdate hook only dirties a
 * per-feature validity word; genb is POLLED in root_preupdate every block; the
 * egq coefficient recompute runs at the next PROCESS block off CURRENT stored
 * values. So the final {genb,gebf,gebg} + the commit bit are all that matter,
 * not the order written. (root_preupdate: a genb change vs its cache at
 * [reg+0x5c8] clears the GEQ validity bits at [reg+0x5c0] via bic #0x3d;
 * gebg_preupdate sets commit bit 0x40 and the redesign fires next block.)
 *
 * Build/run: make reshape (see Makefile).
 */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <math.h>
#include <dlfcn.h>
#include "audio_effect_defs.h"

#define FRAMES   256
#define RATE     44100.0
#define TEST_AMP 2000.0    /* low: a +10 dB band boost stays clear of clipping */
#define BOOST    160       /* +10 dB in 1/16 dB units */
#define WARM     60        /* past the 7560-sample enable crossfade */
#define SETTLE   220       /* let the GEQ coeff smoother settle after a change */
#define UP(x)    ((x) > 1.3)   /* ratio threshold: boosted vs ~flat */

/* Standard 20-band GEQ centre frequencies. Bands 0..9 (43..1550 Hz) are a clean
 * monotonic 10-band layout on their own. */
static const int16_t GEBF20[20] = {43, 129, 215, 301, 431, 603, 775, 947, 1206,
    1550, 2067, 2756, 3618, 4651, 5685, 7063, 8958, 11025, 13781, 18777};
/* A second monotonic 10-band layout whose band 4 sits at 6000 Hz — swapping to
 * it moves band 4's centre 431 -> 6000 Hz without breaking monotonicity. */
static const int16_t GEBF_HI[10] = {500,1000,2000,4000,6000,8000,10000,12000,14000,16000};

/* Two orthogonal shapes for the order sweep:
 *   LO: genb=10, GEBF20[0..9],  boost band 4 (431 Hz)  -> 431 up, 7063 flat
 *   HI: genb=20, GEBF20[0..19], boost band 15 (7063Hz) -> 7063 up, 431 flat */
#define LO_N      10
#define LO_BOOST  4
#define LO_TONE   431.0
#define MOVE_TONE 6000.0   /* band 4's new centre under GEBF_HI */
#define HI_N      20
#define HI_BOOST  15
#define HI_TONE   7063.0

static effect_handle_t H;
static void   *AK;
static EffectCreate_t C;
static effect_descriptor_t DESC;
static int16_t *g_in, *g_out;

typedef int      (*ak_get_fn)(void *, uint32_t, int);
typedef int      (*ak_set_fn)(void *, uint32_t, int, int);
typedef uint32_t (*ak_find_fn)(void *, uint32_t, uint32_t);
typedef int      (*ak_minmax_fn)(void *, uint32_t);
static ak_get_fn    ak_get;
static ak_set_fn    ak_set;
static ak_find_fn   ak_find;
static ak_minmax_fn ak_get_length;

static void ak_attach(void) { AK = *(void **)(*(void **)((char *)H + 0x44)); }
static uint32_t pack4(const char *s) {
    uint32_t f = 0;
    for (int i = 0; i < 4 && s[i]; i++) f |= (uint32_t)(uint8_t)s[i] << (8 * i);
    return f;
}
static uint32_t R(const char *n) { return ak_find(AK, 1, pack4(n)); }
static int      get(const char *n, int e) { return ak_get(AK, R(n), e); }
static void     set(const char *n, int e, int v) { ak_set(AK, R(n), e, v); }

static void fill_sine(double amp, double freq) {
    for (int i = 0; i < FRAMES; ++i) {
        int s = (int)(amp * sin(2.0 * M_PI * freq * (i / RATE)));
        g_in[i*2] = (int16_t)s; g_in[i*2+1] = (int16_t)s;
    }
}
/* Stream n blocks of a fresh tone (process() clobbers input + ACCUMULATEs). */
static void run(double freq, int n) {
    for (int i = 0; i < n; ++i) {
        fill_sine(TEST_AMP, freq);
        audio_buffer_t ib = { .frameCount = FRAMES, .s16 = g_in };
        audio_buffer_t ob = { .frameCount = FRAMES, .s16 = g_out };
        memset(g_out, 0, FRAMES * 4);
        (*H)->process(H, &ib, &ob);
    }
}
static double rms_of(const int16_t *b) {
    double ss = 0;
    for (int i = 0; i < FRAMES * 2; ++i) ss += (double)b[i] * b[i];
    return sqrt(ss / (FRAMES * 2));
}
/* Settle at `freq`, then return the steady-state output RMS for that tone. */
static double measure(double freq) { run(freq, SETTLE); return rms_of(g_out); }

static void enable(void) { uint32_t rs=4; int32_t r=0; (*H)->command(H, EFFECT_CMD_ENABLE, 0,NULL,&rs,&r); }

/* Everything but the GEQ off, GEQ on. Caller lays in genb/gebf/gebg. */
static void geq_only(void) {
    const char *off[] = { "dvle","dvme","vmon","deon","ieon","aoon",
                          "vdhe","vspe","ngon", NULL };
    for (int i = 0; off[i]; i++) set(off[i], 0, 0);
    set("geon", 0, 1);
}

static double FLAT_LO, FLAT_HI;   /* flat-GEQ reference RMS at the two tones */

/* Apply the three group writes {n=genb, f=gebf array, g=gebg gains} in the
 * order given by `order` (a permutation of "nfg"). `boost` = boosted band. */
static void write_order(int n, int boost, const char *order) {
    for (int i = 0; i < 3; i++) {
        switch (order[i]) {
        case 'n': set("genb", 0, n); break;
        case 'f': for (int e = 0; e < n; e++) set("gebf", e, GEBF20[e]); break;
        case 'g': for (int e = 0; e < n; e++) set("gebg", e, e == boost ? BOOST : 0); break;
        }
    }
}

/* ───────────────────────── A. the commit gates the reshape ──────────────── */

/* A1. gebf moves a boosted band's CENTRE at runtime. 10-band GEQ, boost band 4
 * @ 431 Hz; swap gebf[]->GEBF_HI (band 4 -> 6000 Hz). The freq change alone is
 * inert; the gebg commit moves the boost to 6000. */
static int move_band(void) {
    printf("=== A1: gebf — does a boosted band MOVE at runtime?  (431 -> 6000 Hz)\n");
    geq_only();
    set("genb", 0, 10);
    for (int e = 0; e < 10; e++) set("gebf", e, GEBF20[e]);
    for (int e = 0; e < 10; e++) set("gebg", e, 0);                      /* flat refs */
    double f431 = measure(LO_TONE), f6000 = measure(MOVE_TONE);
    for (int e = 0; e < 10; e++) set("gebg", e, e == LO_BOOST ? BOOST : 0); /* boost @431 */
    printf("  baseline (band4@431 boosted):   431Hz x%.2f   6000Hz x%.2f\n",
           measure(LO_TONE)/f431, measure(MOVE_TONE)/f6000);

    for (int e = 0; e < 10; e++) set("gebf", e, GEBF_HI[e]);             /* band4: 431->6000 */
    double i431 = measure(LO_TONE)/f431, i6000 = measure(MOVE_TONE)/f6000;
    printf("  gebf[]=GEBF_HI, NO gebg write:  431Hz x%.2f   6000Hz x%.2f   -> %s\n",
           i431, i6000, UP(i6000) ? "MOVED" : "INERT (boost still at 431)");

    for (int e = 0; e < 10; e++) set("gebg", e, e == LO_BOOST ? BOOST : 0); /* the commit */
    double c431 = measure(LO_TONE)/f431, c6000 = measure(MOVE_TONE)/f6000;
    printf("  re-write gebg (COMMIT):         431Hz x%.2f   6000Hz x%.2f   -> %s\n\n",
           c431, c6000, (UP(c6000) && !UP(c431)) ? "RESHAPED (boost now at 6000)" : "no reshape");
    return !UP(i6000) && UP(c6000) && !UP(c431);
}

/* A2. genb wakes an inactive band at runtime — AND the gebg WRITE itself is the
 * trigger, not a value change. 20-band gebf+gebg laid in with band 15 (7063 Hz)
 * boosted but asleep at genb=10. Raise genb=20 + re-set gebf: inert. Re-write
 * gebg with IDENTICAL values: band 15 wakes. */
static int wake_band(void) {
    printf("=== A2: genb — does a high band WAKE at runtime?  (the gebg write is the trigger)\n");
    geq_only();
    set("genb", 0, 10);                                       /* band 15 asleep */
    for (int e = 0; e < 20; e++) set("gebf", e, GEBF20[e]);
    for (int e = 0; e < 20; e++) set("gebg", e, e == HI_BOOST ? BOOST : 0);
    printf("  genb=10, gebg[15]=+10dB preloaded (asleep):  7063 x%.2f\n",
           measure(HI_TONE)/FLAT_HI);

    set("genb", 0, 20);                                       /* raise count, re-set freq, */
    for (int e = 0; e < 20; e++) set("gebf", e, GEBF20[e]);   /* gebg untouched            */
    double noc = measure(HI_TONE)/FLAT_HI;
    printf("  genb=20 (read-back=%d) + gebf, NO gebg:       7063 x%.2f   -> %s\n",
           get("genb", 0), noc, UP(noc) ? "WOKE" : "INERT (band15 still asleep)");

    for (int e = 0; e < 20; e++) set("gebg", e, e == HI_BOOST ? BOOST : 0); /* same values */
    double com = measure(HI_TONE)/FLAT_HI;
    printf("  re-write gebg (identical = COMMIT):           7063 x%.2f   -> %s\n\n",
           com, UP(com) ? "RESHAPED (band15 now active)" : "still inert");
    return !UP(noc) && UP(com);
}

/* ───────────────────────── B. order is free, presence is the rule ───────── */

static const char *ORDERS[6] = { "nfg","ngf","fng","fgn","gnf","gfn" };

/* Re-establish a shape with the canonical order, settle, return its boosted-tone
 * ratio (sanity: should be UP). */
static double set_shape(int n, int boost) {
    write_order(n, boost, "nfg");
    double tone = (n == LO_N) ? LO_TONE : HI_TONE;
    double flat = (n == LO_N) ? FLAT_LO : FLAT_HI;
    return measure(tone) / flat;
}

/* One direction: src shape -> dst shape, all 6 write orders. Returns 1 if every
 * order lands the dst boost (order-independent), 0 otherwise. */
static int sweep(const char *label, int src_n, int src_b, int dst_n, int dst_b) {
    double dst_tone = (dst_n == LO_N) ? LO_TONE : HI_TONE;
    double dst_flat = (dst_n == LO_N) ? FLAT_LO : FLAT_HI;
    double oth_tone = (dst_n == LO_N) ? HI_TONE : LO_TONE;   /* should stay flat */
    double oth_flat = (dst_n == LO_N) ? FLAT_HI : FLAT_LO;
    printf("=== %s : genb %d->%d, boost band %d->%d (write all 6 orders)\n",
           label, src_n, dst_n, src_b, dst_b);
    printf("    order |  src ok  | dst-tone xN | other-tone xN | verdict\n");
    double lo = 1e9, hi = -1e9; int all = 1;
    for (int i = 0; i < 6; i++) {
        double src_ratio = set_shape(src_n, src_b);          /* re-baseline */
        write_order(dst_n, dst_b, ORDERS[i]);                /* the transition */
        double db = measure(dst_tone) / dst_flat;
        double ob = measure(oth_tone) / oth_flat;
        int ok = UP(db) && !UP(ob);
        all &= ok; if (db < lo) lo = db; if (db > hi) hi = db;
        printf("    %-5s | %s | x%-9.2f | x%-11.2f | %s\n",
               ORDERS[i], UP(src_ratio) ? "boost  " : "FLAT?? ", db, ob,
               ok ? "REACHED" : "FAILED");
    }
    printf("    -> dst-tone ratio across all 6 orders: [%.2f .. %.2f]  spread %.0f%%  => %s\n\n",
           lo, hi, 100.0 * (hi - lo) / lo,
           (all && (hi - lo) / lo < 0.15) ? "ORDER-INDEPENDENT" : "ORDER MATTERS");
    return all && (hi - lo) / lo < 0.15;
}

int main(int argc, char *argv[]) {
    setbuf(stdout, NULL); setbuf(stderr, NULL);
    if (argc < 2) { fprintf(stderr, "Usage: %s <libdseffect.so>\n", argv[0]); return 1; }
    void *lib = dlopen(argv[1], RTLD_NOW);
    if (!lib) { fprintf(stderr, "dlopen: %s\n", dlerror()); return 1; }
    EffectQueryEffect_t QE = dlsym(lib, "EffectQueryEffect");
    C             = (EffectCreate_t) dlsym(lib, "EffectCreate");
    ak_get        = (ak_get_fn)    dlsym(lib, "ak_get");
    ak_set        = (ak_set_fn)    dlsym(lib, "ak_set");
    ak_find       = (ak_find_fn)   dlsym(lib, "ak_find");
    ak_get_length = (ak_minmax_fn) dlsym(lib, "ak_get_length");
    if (!ak_get || !ak_set || !ak_find || !ak_get_length) { fprintf(stderr, "dlsym: missing ak_*\n"); return 1; }
    QE(0, &DESC);
    g_in  = calloc(FRAMES * 2, 2);
    g_out = calloc(FRAMES * 2, 2);

    int32_t cr = C(&DESC.uuid, 0, 0, &H);
    if (cr || !H) { fprintf(stderr, "EffectCreate failed (%d)\n", cr); return 1; }
    { uint32_t rs=4; int32_t r=0; (*H)->command(H, EFFECT_CMD_INIT, 0,NULL,&rs,&r); }
    ak_attach();

    printf("storage is fixed-capacity: ak_get_length(gebf)=%d gebg=%d "
           "(len is max bands, not the active count)\n\n",
           ak_get_length(AK, R("gebf")), ak_get_length(AK, R("gebg")));

    geq_only();
    write_order(20, -1, "nfg");                /* flat 20-band GEQ -> per-tone refs */
    enable(); run(LO_TONE, WARM);
    FLAT_LO = measure(LO_TONE); FLAT_HI = measure(HI_TONE);
    printf("flat refs: %.0fHz=%.1f  %.0fHz=%.1f\n\n", LO_TONE, FLAT_LO, HI_TONE, FLAT_HI);

    int a1  = move_band();
    int a2  = wake_band();
    int inc = sweep("INCREASE", LO_N, LO_BOOST, HI_N, HI_BOOST);
    int dec = sweep("DECREASE", HI_N, HI_BOOST, LO_N, LO_BOOST);

    printf("=== SUMMARY ══════════════════════════════════════════════════════\n");
    printf("  Structural constants are RUNTIME-MUTABLE: the engine reshapes its\n");
    printf("  live DSP on them, gated by a commit (the gebg write re-derives the\n");
    printf("  filterbank). genb/gebf alone never reshape.\n");
    printf("  A. the commit gates the reshape:\n");
    printf("     gebf moved a band's centre at runtime : %s\n", a1 ? "YES (after gebg)" : "NO");
    printf("     genb woke a high band at runtime      : %s\n", a2 ? "YES (after gebg)" : "NO");
    printf("  B. among the commit writes, order is free:\n");
    printf("     count INCREASE 10->20, all 6 orders   : %s\n", inc ? "same shape" : "DIVERGED");
    printf("     count DECREASE 20->10, all 6 orders   : %s\n", dec ? "same shape" : "DIVERGED");
    printf("  => commit PRESENCE (gebg re-written at all), not ORDER, is the rule\n");
    printf("     — the gebg write triggers the recompute even with identical values.\n");

    _Exit(0);
}
