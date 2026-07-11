/*
 * lifecycle_probe.c — PROTOTYPE/EXPERIMENT: where should `dump defaults`
 * capture the engine's power-on defaults?
 *
 * `make dump-defaults` (ddp_probe.c dump_defaults) reads the 64 root leaves
 * right after open + DEFINE handshake — before SET_CONFIG, ENABLE, or any
 * process block. Slice 03 (#11) found power-on defaults outside their own
 * write bounds (gebf/iebf/aobf/arbf zero-tails < min, vnnb=0 in [1..20],
 * vnbf=0).
 * Hypothesis: a later lifecycle point may show those slots initialized —
 * making today's capture partially pre-init state, not true defaults.
 *
 * This probe snapshots ALL root leaves (full length, per-element ak_get —
 * the exact accessor dump_defaults prints) at six lifecycle stages:
 *
 *   A  post-EffectCreate + INIT       (pre-handshake "true open")
 *   B  post-DEFINE handshake           (today's dump-defaults capture point)
 *   C  post-SET_CONFIG(rate)           (Ds1ap rebuilt: re-attach + re-walk)
 *   D  post-ENABLE
 *   E  after 40 process blocks         (3-tone mix, ACCUMULATE, out zeroed)
 *   F  vis enabled (cmd7 + ven=1) + 40 more blocks   [supplementary: pins
 *      whether the visualizer slots need the vis enable, not just runtime]
 *
 * One full run per rate {44100, 48000, 32000} on a fresh handle. Reports:
 * per-transition slot diffs, out-of-bounds counts per stage (vs that stage's
 * own ak_get_min/max — re-read after SET_CONFIG in case bounds move), the
 * cross-rate diff of stage C/E vs the 44.1k baseline, and a verdict:
 * which params move at all, any non-visualizer movers, and which boot OOB
 * values become in-bounds at which stage.
 *
 * Build/run: `make lifecycle`. Boilerplate lifted from vis_native_probe /
 * akctl_probe (proven attach offsets, cmd plumbing, 3-tone warm loop).
 * NO host cmd-3 SETs and no genb/gebf writes — pure lifecycle, so the
 * registry only moves when the ENGINE moves it.
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
#define DS_PARAM_VISUALIZER_ENABLE   7

/* Canonical 64-name DEFINE_PARAMS table (verbatim from ddp_probe G[]) — only
 * used to replicate today's handshake before stage B; reads walk the tree. */
typedef struct { const char *name; int len; } ak_param_t;
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

/* effect_config_t as the engine reads it (see setconfig_probe.c) */
typedef struct {
    uint32_t frameCount; void *raw; uint32_t samplingRate; uint32_t channels;
    void *bp_get; void *bp_rel; void *bp_cookie;
    uint8_t format; uint8_t accessMode; uint16_t mask;
} buf_cfg_t;
typedef struct { buf_cfg_t in, out; } cfg_t;
#define CH_STEREO 3
#define FMT_PCM16 1
#define ACC_ACCUM 2

static effect_handle_t H;

/* ── engine AK API (offsets/symbols proven by ddp_probe/akctl_probe) ── */
typedef int      (*ak_get_fn)(void *, uint32_t, int);
typedef int      (*ak_set_fn)(void *, uint32_t, int, int);
typedef uint32_t (*ak_get_name_fn)(void *, uint32_t);
typedef int      (*ak_minmax_fn)(void *, uint32_t);
typedef uint32_t (*ak_enum_fn)(void *, uint32_t, int);
typedef uint32_t (*ak_find_fn)(void *, uint32_t, uint32_t);
static ak_get_fn      ak_get;
static ak_set_fn      ak_set;
static ak_get_name_fn ak_get_name;
static ak_minmax_fn   ak_get_min, ak_get_max, ak_get_length, ak_get_type;
static ak_enum_fn     ak_enum;
static ak_find_fn     ak_find;
static void *AK;

static void ak_attach(void) { AK = *(void **)(*(void **)((char *)H + 0x44)); }
static void ak_fourcc(uint32_t f, char *buf) {
    buf[0] = f; buf[1] = f >> 8; buf[2] = f >> 16; buf[3] = f >> 24; buf[4] = 0;
}
static uint32_t pack4(const char *s) {
    uint32_t f = 0;
    for (int i = 0; i < 4 && s[i]; i++) f |= (uint32_t)(uint8_t)s[i] << (8 * i);
    return f;
}

/* ── root-leaf table, rebuilt after every attach (SET_CONFIG rebuilds AK) ── */
#define MAXLEAF 80
#define MAXLEN  168      /* lcpt */
typedef struct { uint32_t ref; char fc[5]; int len, min, max, type; } leaf_t;
static leaf_t L[MAXLEAF];
static int    NL;

static int walk_leaves(void) {
    NL = 0;
    for (int i = 0; i < 400 && NL < MAXLEAF; i++) {
        uint32_t r = ak_enum(AK, 1, i);
        if (!r) break;
        if (ak_enum(AK, r, 0)) continue;                /* node — leaves only */
        leaf_t *l = &L[NL++];
        l->ref = r; ak_fourcc(ak_get_name(AK, r), l->fc);
        l->len = ak_get_length(AK, r);
        if (l->len > MAXLEN) l->len = MAXLEN;
        l->min = ak_get_min(AK, r); l->max = ak_get_max(AK, r);
        l->type = ak_get_type(AK, r);
    }
    return NL;
}

/* ── per-stage snapshots: values + the bounds in force at that stage ── */
#define NSTAGE 6
static const char *SNAME[NSTAGE] = {
    "A post-open (pre-handshake)", "B post-DEFINE handshake (today's capture)",
    "C post-SET_CONFIG", "D post-ENABLE", "E post-40-blocks",
    "F vis-enabled +40 blocks",
};
typedef struct {
    int  n;                       /* leaf count at this stage             */
    char fc[MAXLEAF][5];
    int  len[MAXLEAF], min[MAXLEAF], max[MAXLEAF], type[MAXLEAF];
    int  v[MAXLEAF][MAXLEN];
} snap_t;
static snap_t SB[NSTAGE];         /* baseline run (44100)  */
static snap_t SR[NSTAGE];         /* current rate run      */

static void take(snap_t *s) {
    s->n = NL;
    for (int i = 0; i < NL; i++) {
        strcpy(s->fc[i], L[i].fc);
        s->len[i] = L[i].len; s->min[i] = L[i].min; s->max[i] = L[i].max;
        s->type[i] = L[i].type;
        for (int e = 0; e < L[i].len; e++)
            s->v[i][e] = ak_get(AK, L[i].ref, e);
    }
}

static int oob(const snap_t *s, int i, int e) {
    return s->v[i][e] < s->min[i] || s->v[i][e] > s->max[i];
}

/* diff stage a -> b; print changed slots; mark `moved` per leaf. Returns
 * number of changed leaves. Leaves matched by index (walk order is stable —
 * verified by the fc check). */
static int diff_stages(const snap_t *a, const snap_t *b, const char *label,
                       uint8_t *moved) {
    int nch = 0;
    if (a->n != b->n)
        printf("  !! leaf count changed %d -> %d\n", a->n, b->n);
    printf("── %s ──\n", label);
    for (int i = 0; i < a->n && i < b->n; i++) {
        if (strcmp(a->fc[i], b->fc[i]))
            printf("  !! leaf %d renamed %s -> %s\n", i, a->fc[i], b->fc[i]);
        if (a->min[i] != b->min[i] || a->max[i] != b->max[i])
            printf("  %-4s bounds moved [%d..%d] -> [%d..%d]\n", b->fc[i],
                   a->min[i], a->max[i], b->min[i], b->max[i]);
        int k = 0, len = a->len[i] < b->len[i] ? a->len[i] : b->len[i];
        for (int e = 0; e < len; e++) if (a->v[i][e] != b->v[i][e]) k++;
        if (!k) continue;
        nch++; if (moved) moved[i] = 1;
        printf("  %-4s %2d/%-3d slots:", b->fc[i], k, b->len[i]);
        int shown = 0;
        for (int e = 0; e < len && shown < 6; e++)
            if (a->v[i][e] != b->v[i][e]) {
                printf(" [%d]%d->%d", e, a->v[i][e], b->v[i][e]);
                shown++;
            }
        if (k > shown) printf(" (+%d more)", k - shown);
        printf("\n");
    }
    if (!nch) printf("  (no leaf changed)\n");
    return nch;
}

/* out-of-bounds report for one stage (vs that stage's own bounds) */
static void oob_report(const snap_t *s, const char *label) {
    printf("── OOB @ %s ──\n", label);
    int any = 0;
    for (int i = 0; i < s->n; i++) {
        int k = 0, ex = -1;
        for (int e = 0; e < s->len[i]; e++)
            if (oob(s, i, e)) { k++; if (ex < 0) ex = e; }
        if (!k) continue;
        any = 1;
        printf("  %-4s oob=%2d/%-3d  e.g. [%d]=%d  bounds [%d..%d]  type=%d\n",
               s->fc[i], k, s->len[i], ex, s->v[i][ex], s->min[i], s->max[i],
               s->type[i]);
    }
    if (!any) printf("  (none)\n");
}

/* ── cmd plumbing (trimmed from vis_native_probe) ───────────────────── */
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
static void define_params(void) {
    uint8_t *buf = calloc(1, 2 + NPARAM * 4);
    *(int16_t *)buf = (int16_t)NPARAM;
    for (int i = 0; i < NPARAM; ++i)
        memcpy(buf + 2 + i * 4, G[i].name, strlen(G[i].name));
    cmd_set(DS_PARAM_DEFINE_PARAMS, buf, 2 + NPARAM * 4);
    free(buf);
}
static void define_settings_all(void) {
    int total = 0;
    for (int i = 0; i < NPARAM; ++i) total += G[i].len;
    uint8_t *buf = calloc(1, 2 + total * 3);
    *(int16_t *)buf = (int16_t)total;
    int pos = 2;
    for (int i = 0; i < NPARAM; ++i)
        for (int e = 0; e < G[i].len; ++e) {
            buf[pos++] = (uint8_t)i;
            *(int16_t *)(buf + pos) = (int16_t)e; pos += 2;
        }
    cmd_set(DS_PARAM_DEFINE_SETTINGS, buf, 2 + total * 3);
    free(buf);
}
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

/* ── audio: 3-tone mix at the run's rate (from vis_native_probe) ─────── */
static void fill_mix(int16_t *pcm, int frames, double rate) {
    for (int i = 0; i < frames; ++i) {
        double t = i / rate;
        double s = 9000*sin(2*M_PI*180*t) + 7000*sin(2*M_PI*1500*t)
                 + 6000*sin(2*M_PI*9000*t);
        pcm[i*2] = pcm[i*2+1] = (int16_t)s;
    }
}
static void warm(int frames, int n, double rate) {
    static int16_t in[512 * 2], out[512 * 2];
    for (int i = 0; i < n; ++i) {
        fill_mix(in, frames, rate);
        audio_buffer_t ib = { .frameCount = (uint32_t)frames, .s16 = in };
        audio_buffer_t ob = { .frameCount = (uint32_t)frames, .s16 = out };
        memset(out, 0, frames * 4);
        (*H)->process(H, &ib, &ob);
    }
}

/* ── one full lifecycle run at `rate` on a fresh handle ──────────────── */
static EffectCreate_t C;
static effect_descriptor_t desc;

static void run_lifecycle(uint32_t rate, snap_t *S, int session) {
    uint32_t rs = 4; int32_t r = 0;
    if (C(&desc.uuid, session, session, &H) || !H) {
        fprintf(stderr, "EffectCreate failed (rate %u)\n", rate); exit(1);
    }
    (*H)->command(H, EFFECT_CMD_INIT, 0, NULL, &rs, &r);
    ak_attach(); walk_leaves();                    /* AK exists pre-handshake */
    take(&S[0]);                                   /* A */
    define_params(); define_settings_all();        /* today's capture env    */
    take(&S[1]);                                   /* B */
    send_config(rate);
    ak_attach(); walk_leaves();                    /* Ds1ap rebuilt by cmd 1 */
    take(&S[2]);                                   /* C */
    rs = 4; r = 0;
    (*H)->command(H, EFFECT_CMD_ENABLE, 0, NULL, &rs, &r);
    take(&S[3]);                                   /* D */
    warm(256, 40, (double)rate);
    take(&S[4]);                                   /* E */
    int32_t vis_on = 1;
    cmd_set(DS_PARAM_VISUALIZER_ENABLE, &vis_on, 4);
    uint32_t rv = ak_find(AK, 1, pack4("ven"));
    if (rv) ak_set(AK, rv, 0, 1);
    warm(256, 40, (double)rate);
    take(&S[5]);                                   /* F */
}

int main(int argc, char *argv[]) {
    setbuf(stdout, NULL); setbuf(stderr, NULL);
    if (argc < 2) { fprintf(stderr, "usage: %s <libdseffect.so>\n", argv[0]); return 1; }
    void *lib = dlopen(argv[1], RTLD_NOW);
    if (!lib) { fprintf(stderr, "dlopen: %s\n", dlerror()); return 1; }
    EffectQueryNumberEffects_t Q = dlsym(lib, "EffectQueryNumberEffects");
    EffectQueryEffect_t       QE = dlsym(lib, "EffectQueryEffect");
    C = dlsym(lib, "EffectCreate");
    ak_get        = (ak_get_fn)      dlsym(lib, "ak_get");
    ak_set        = (ak_set_fn)      dlsym(lib, "ak_set");
    ak_get_name   = (ak_get_name_fn) dlsym(lib, "ak_get_name");
    ak_get_min    = (ak_minmax_fn)   dlsym(lib, "ak_get_min");
    ak_get_max    = (ak_minmax_fn)   dlsym(lib, "ak_get_max");
    ak_get_length = (ak_minmax_fn)   dlsym(lib, "ak_get_length");
    ak_get_type   = (ak_minmax_fn)   dlsym(lib, "ak_get_type");
    ak_enum       = (ak_enum_fn)     dlsym(lib, "ak_enum");
    ak_find       = (ak_find_fn)     dlsym(lib, "ak_find");
    if (!ak_get || !ak_enum || !ak_get_min || !ak_get_max || !ak_get_length) {
        fprintf(stderr, "dlsym: missing ak_* accessor\n"); return 1;
    }
    uint32_t n = 0; Q(&n); QE(0, &desc);

    printf("=== LIFECYCLE DEFAULTS PROBE — where do 'power-on defaults' live? ===\n");
    printf("stages: A open | B +DEFINE handshake (today) | C +SET_CONFIG | "
           "D +ENABLE | E +40 blocks | F +vis-enable +40 blocks\n");
    printf("no host param writes anywhere before F (F writes only ven=1).\n\n");

    /* ── baseline run @44100, full per-transition detail ─────────────── */
    printf("################ RUN @44100 (baseline) ################\n");
    run_lifecycle(44100, SB, 0);
    printf("root leaves: %d\n\n", SB[0].n);
    uint8_t moved[MAXLEAF] = {0}, movedF[MAXLEAF] = {0};
    diff_stages(&SB[0], &SB[1], "A -> B  (DEFINE handshake)", moved);
    diff_stages(&SB[1], &SB[2], "B -> C  (SET_CONFIG 44100)", moved);
    diff_stages(&SB[2], &SB[3], "C -> D  (ENABLE)", moved);
    diff_stages(&SB[3], &SB[4], "D -> E  (40 process blocks)", moved);
    diff_stages(&SB[4], &SB[5], "E -> F  (vis on + 40 blocks)  [supplementary]",
                movedF);
    printf("\n");
    for (int st = 0; st < NSTAGE; st++) oob_report(&SB[st], SNAME[st]);

    /* ── rate runs: what does stage C/E look like at 48k / 32k? ──────── */
    static const uint32_t RATES[2] = {48000, 32000};
    uint8_t rate_dep[MAXLEAF] = {0};
    for (int rr = 0; rr < 2; rr++) {
        printf("\n################ RUN @%u ################\n", RATES[rr]);
        run_lifecycle(RATES[rr], SR, 10 + rr);
        /* sanity: pre-SET_CONFIG stages must match the baseline exactly */
        char lbl[96];
        int d = 0;
        for (int i = 0; i < SB[1].n; i++)
            for (int e = 0; e < SB[1].len[i]; e++)
                if (SB[1].v[i][e] != SR[1].v[i][e]) d++;
        printf("stage B vs baseline B: %d differing slots %s\n", d,
               d ? "!! open-state not deterministic" : "(deterministic open)");
        snprintf(lbl, sizeof lbl, "C@44100 -> C@%u  (rate dependence)", RATES[rr]);
        diff_stages(&SB[2], &SR[2], lbl, rate_dep);
        snprintf(lbl, sizeof lbl, "C -> D -> E @%u (own lifecycle)", RATES[rr]);
        diff_stages(&SR[2], &SR[4], lbl, moved);
        diff_stages(&SR[4], &SR[5], "E -> F (vis) — rate run", movedF);
        oob_report(&SR[4], "E @ this rate");
        oob_report(&SR[5], "F @ this rate");
    }

    /* ── verdict ─────────────────────────────────────────────────────── */
    printf("\n=== VERDICT ===\n");
    printf("leaves that moved across A..E (any rate), i.e. pure lifecycle:\n   ");
    int nm = 0;
    for (int i = 0; i < SB[0].n; i++)
        if (moved[i]) { printf(" %s", SB[0].fc[i]); nm++; }
    printf("%s\n", nm ? "" : " (none)");
    printf("leaves that moved only once vis was enabled (E -> F):\n   ");
    nm = 0;
    for (int i = 0; i < SB[0].n; i++)
        if (movedF[i] && !moved[i]) { printf(" %s", SB[0].fc[i]); nm++; }
    printf("%s\n", nm ? "" : " (none)");
    printf("rate-dependent stage-C values:\n   ");
    nm = 0;
    for (int i = 0; i < SB[0].n; i++)
        if (rate_dep[i]) { printf(" %s", SB[0].fc[i]); nm++; }
    printf("%s\n", nm ? "" : " (none)");

    printf("\nboot-OOB slots (stage A/B) that became in-bounds later (44.1k run):\n");
    int any = 0;
    for (int i = 0; i < SB[1].n; i++) {
        int ka = 0, ke = 0, kf = 0;
        for (int e = 0; e < SB[1].len[i]; e++) {
            if (!oob(&SB[1], i, e)) continue;
            ka++;
            if (!oob(&SB[4], i, e)) ke++;
            if (!oob(&SB[5], i, e)) kf++;
        }
        if (!ka) continue;
        any = 1;
        printf("  %-4s boot-oob=%2d/%-3d  in-bounds by E: %2d  by F: %2d\n",
               SB[1].fc[i], ka, SB[1].len[i], ke, kf);
    }
    if (!any) printf("  (no boot OOB at all?)\n");
    _Exit(0);
}
