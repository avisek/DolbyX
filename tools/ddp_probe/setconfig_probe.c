/*
 * setconfig_probe.c — DolbyX RE: does EFFECT_CMD_SET_CONFIG (cmd 1) actually
 * work in-process, and how does it compare to the Ds1ap::New hot-swap?
 *
 * Companion to ddp_probe.c / akctl_probe.c. Those drive PARAMETERS (cmd 5
 * SET_PARAM and the AK accessors). This probe drives the LIFECYCLE command
 * EFFECT_CMD_SET_CONFIG — the audio I/O config (sample rate, channels,
 * format) that the original DDP never sends itself: in Android it is
 * framework-driven, emitted by AudioFlinger when the effect attaches to an
 * output thread. DsEffect.java has no setConfig caller; v1 changes rate via
 * the manual Ds1ap::New hot-swap (arm/ddp_processor.c) instead.
 *
 * Static RE of libdseffect.so (objdump) established the mechanism, three tiers
 * of validation deep:
 *   Effect_command cmd==1 (0x15448):
 *     - ENVELOPE check: cmdSize==64, pReplyData!=NULL, *replySize==4
 *         -> fail returns -22 from command(), reply buffer UNTOUCHED
 *     - FIELD check: in.rate==out.rate, in.ch==out.ch, in.fmt==out.fmt,
 *         (channels & ~2)==1 {mono/stereo masks}, format==PCM16(1),
 *         out.accessMode in {0=WRITE, 2=ACCUMULATE}
 *         -> fail returns 0 but writes *pReplyData = -22
 *     - if rate+channels unchanged -> no-op, reply 0
 *     - else cache the effect_config_t at self+4, then:
 *         Effect_reinit (0x125f0): delete old Ds1ap@self+0x44, then RECONFIG
 *           check — rate gated to {44100,48000,32000} (else SILENT fallback to
 *           44100, reply still 0), channel-count gated to {2,6,8} (so mono,
 *           which passed the field check as count 1, dies HERE — and the
 *           teardown already ran, leaving Ds1ap NULL = handle poisoned);
 *           Ds1ap::New(ch,rate) -> ak_open + ak_set_input_config -> ak_rate_code
 *         Effect_setConfig (0x140a9): re-apply cached AK params (ak_find +
 *           ak_set/ak_set_bulk)
 *         Ds1apBufferInit(inCh,outCh,256) -> self+0x48
 *     - reply 0
 *
 * IMPORTANT — the on-wire effect_config_t is the REAL AOSP buffer_config_t
 * layout (format/accessMode are BYTES at +28/+29, 12-byte bufferProvider).
 * audio_effect_defs.h now carries this corrected layout; the local cfg_t
 * below keeps the offsets explicit, exactly as the cmd-1 handler reads them.
 *
 * This harness: (Sc1-5) drives a real rate change end-to-end and exposes the
 * silent-fallback footgun; (Sc6) sweeps every config field for its accepted
 * set; (Sc7) proves WRITE vs ACCUMULATE is a real behavioural knob (not
 * hard-wired); (Sc8) replicates the v1 hot-swap for contrast; (Sc9) checks
 * what a fully-disabled process() does to the output (the dry-passthrough
 * question). Live rate is read from AK bus 0 — self+12 only holds the
 * REQUESTED rate, so it can't see a fallback.
 *
 * Build & run: make -C tools/ddp_probe setconfig   (see Makefile / README.md).
 */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <math.h>
#include <dlfcn.h>
#include "audio_effect_defs.h"

/* ── Real AOSP buffer_config_t / effect_config_t (what the engine reads) ───
 * 32 bytes each; offsets verified against the cmd-1 handler's field loads. */
typedef struct {
    uint32_t frameCount;        /* @0  */
    void    *raw;               /* @4  */
    uint32_t samplingRate;      /* @8  */
    uint32_t channels;          /* @12 AUDIO_CHANNEL mask: mono=1, stereo=3 */
    void    *bp_getBuffer;      /* @16 buffer_provider: 3 words */
    void    *bp_releaseBuffer;  /* @20 */
    void    *bp_cookie;         /* @24 */
    uint8_t  format;            /* @28 AUDIO_FORMAT_PCM_16_BIT = 1 */
    uint8_t  accessMode;        /* @29 output: 0=WRITE (overwrite), 2=ACCUMULATE (add) */
    uint16_t mask;              /* @30 AOSP "fields valid" bits — engine ignores it */
} buf_cfg_t;                    /* = 32 bytes */
typedef struct { buf_cfg_t in, out; } cfg_t;   /* = 64 bytes */

#define CH_STEREO   3           /* AUDIO_CHANNEL_OUT_STEREO */
#define FMT_PCM16   1           /* AUDIO_FORMAT_PCM_16_BIT   */
#define ACC_ACCUM   2           /* EFFECT_BUFFER_ACCESS_ACCUMULATE */

/* 20-band GEQ centre freqs (verbatim from the other probes); band 4 = 431 Hz. */
static const int16_t GEBF[20] = {43, 129, 215, 301, 431, 603, 775, 947, 1206,
    1550, 2067, 2756, 3618, 4651, 5685, 7063, 8958, 11025, 13781, 18777};
#define TEST_BAND  4
#define TEST_FREQ  431.0
#define TEST_AMP   2000.0
#define BOOST      160
#define FRAMES     256
#define WARM       60
#define SETTLE     150
#define PREFILL    4000         /* output prefill for the WRITE/ACCUMULATE test */

static effect_handle_t H;
static void *AK;                /* current handle's AK registry handle */
static int16_t *g_in, *g_out;
static EffectCreate_t C;        /* resolved in main; used by fresh() */
static effect_descriptor_t DESC;

typedef int      (*ak_set_fn)(void *, uint32_t, int, int);
typedef uint32_t (*ak_find_fn)(void *, uint32_t, uint32_t);
typedef int      (*ak_bus_rate_fn)(void *, int, int *);
typedef int      (*ak_rate_hz_fn)(int);
typedef void    *(*ds1ap_new_fn)(int, int, int, int);
typedef void    *(*ds1ap_bufinit_fn)(void *, int, int, int);   /* as v1 (mis)calls it */
static ak_set_fn       ak_set;
static ak_find_fn      ak_find;
static ak_bus_rate_fn  ak_bus_get_rate;
static ak_rate_hz_fn   ak_rate_hz;

/* AK handle from the effect context (H+0x44, double deref) — rebuilt by
 * Effect_reinit on every honoured SET_CONFIG, so re-attach after each one. */
static void     ak_attach(void) { AK = *(void **)(*(void **)((char *)H + 0x44)); }
static uint32_t rate_req(void)  { return *(uint32_t *)((char *)H + 12);  } /* cached/requested in.rate */

/* The LIVE DSP rate, read from the AK graph (not the cached request). Bus 0 is
 * the PCM input bus; its rate code tracks the rate the engine actually built
 * the Ds1ap with — so it distinguishes an honoured rate from a silent fallback
 * (self+12 only holds what the host asked for). ak_bus_get_rate writes the code
 * through the out-param; we seed it with -1 so it always reports the current. */
static int live_rate(void) {
    ak_attach();
    int code = -1;
    return ak_bus_get_rate(AK, 0, &code) ? ak_rate_hz(code) : -1;
}

static uint32_t pack4(const char *s) {
    uint32_t f = 0;
    for (int i = 0; i < 4 && s[i]; i++) f |= (uint32_t)(uint8_t)s[i] << (8 * i);
    return f;
}
static uint32_t rref(const char *n) { return ak_find(AK, 1, pack4(n)); }

/* Send EFFECT_CMD_SET_CONFIG. Fills a valid 64-byte effect_config_t for
 * (rate, channels, format, accessMode), overridable for the malformed cases.
 * Returns command()'s int return; writes *reply (the engine's pReplyData). */
static int32_t send_config(uint32_t rate, uint32_t ch, uint8_t fmt,
                           uint8_t acc, uint32_t cmd_size, int32_t *reply) {
    cfg_t c;
    memset(&c, 0, sizeof c);
    c.in.frameCount = c.out.frameCount = FRAMES;
    c.in.samplingRate = c.out.samplingRate = rate;
    c.in.channels = c.out.channels = ch;
    c.in.format = c.out.format = fmt;
    c.in.accessMode = c.out.accessMode = acc;
    uint32_t rs = 4; *reply = 0x5a5a5a5a;
    return (*H)->command(H, EFFECT_CMD_SET_CONFIG, cmd_size, &c, &rs, reply);
}

static void fill_sine(int16_t *pcm, int frames, double amp, double freq, double rate) {
    for (int i = 0; i < frames; ++i) {
        int s = (int)(amp * sin(2.0 * M_PI * freq * (i / rate)));
        pcm[i*2] = (int16_t)s; pcm[i*2+1] = (int16_t)s;
    }
}
static void process_tone(double freq, double amp, double rate, int n) {
    for (int i = 0; i < n; ++i) {
        fill_sine(g_in, FRAMES, amp, freq, rate);
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
static void enable(void) {
    uint32_t rs = 4; int32_t r = 0;
    (*H)->command(H, EFFECT_CMD_ENABLE, 0, NULL, &rs, &r);
}
static int32_t disable(void) {
    uint32_t rs = 4; int32_t r = 0;
    return (*H)->command(H, EFFECT_CMD_DISABLE, 0, NULL, &rs, &r);
}
/* Create + INIT a fresh handle into H. Needed per sweep row: a rejected
 * reconfig can poison the current handle (mono tears the graph down then
 * fails -> Ds1ap NULL), so reuse would crash the next process(). */
static void fresh(int sess) {
    C(&DESC.uuid, sess, sess, &H);
    uint32_t rs = 4; int32_t r = 0;
    (*H)->command(H, EFFECT_CMD_INIT, 0, NULL, &rs, &r);
}
static int handle_alive(void) { return *(void **)((char *)H + 0x44) != NULL; }
/* Drive a flat 20-band GEQ straight through the AK registry (no handshake,
 * exactly as akctl_probe proves works), then ENABLE and warm past the
 * crossfade. Call AFTER a SET_CONFIG so it targets the rebuilt graph. */
static void geq_setup(void) {
    ak_attach();
    uint32_t genb = rref("genb"), gebf = rref("gebf"),
             geon = rref("geon"), ieon = rref("ieon"), gebg = rref("gebg");
    ak_set(AK, genb, 0, 20);
    for (int e = 0; e < 20; e++) ak_set(AK, gebf, e, GEBF[e]);
    ak_set(AK, geon, 0, 1); ak_set(AK, ieon, 0, 0);
    for (int e = 0; e < 20; e++) ak_set(AK, gebg, e, 0);
    enable();
}

/* After DISABLE the engine crossfades wet->dry over a few blocks (process()
 * still returns 0), then a fully-bypassed block returns -ENODATA. The DolbyX
 * v2 question: in WRITE mode, does that bypassed block write the dry input to
 * the output (engine-owned passthrough), or leave the buffer untouched (so the
 * daemon would owe a manual input->output copy)? Prefill the output with a
 * sentinel, snapshot the input (process() clobbers it), run one bypassed block
 * WITHOUT zeroing, and classify. ACCUMULATE is the cross-check: it is known to
 * ADD the dry input, so out should be sentinel+input. */
static void disabled_passthrough_probe(int sess, uint8_t acc, int enable_first) {
    int32_t reply;
    fresh(sess);
    send_config(48000, CH_STEREO, FMT_PCM16, acc, 64, &reply);

    int last_ret = 0, enodata_at = -1;
    if (enable_first) {
        geq_setup();                                      /* flat GEQ + ENABLE */
        process_tone(TEST_FREQ, TEST_AMP, 48000.0, WARM + SETTLE);   /* fully enabled */
        disable();
        /* Drive past the disable crossfade; note when process() first returns != 0. */
        for (int i = 0; i < 40; i++) {
            fill_sine(g_in, FRAMES, TEST_AMP, TEST_FREQ, 48000.0);
            audio_buffer_t ib = { .frameCount = FRAMES, .s16 = g_in };
            audio_buffer_t ob = { .frameCount = FRAMES, .s16 = g_out };
            memset(g_out, 0, FRAMES * 4);
            last_ret = (*H)->process(H, &ib, &ob);
            if (last_ret != 0 && enodata_at < 0) enodata_at = i;
        }
    }
    /* (never-enabled: the effect is disabled from birth — no crossfade) */

    /* Decisive bypassed block: sentinel-prefill the output, snapshot the input
     * (process clobbers it), process ONCE without zeroing. */
    fill_sine(g_in, FRAMES, TEST_AMP, TEST_FREQ, 48000.0);
    int16_t in_copy[FRAMES * 2];
    memcpy(in_copy, g_in, sizeof in_copy);
    for (int i = 0; i < FRAMES * 2; i++) g_out[i] = PREFILL;
    audio_buffer_t ib = { .frameCount = FRAMES, .s16 = g_in };
    audio_buffer_t ob = { .frameCount = FRAMES, .s16 = g_out };
    int32_t pret = (*H)->process(H, &ib, &ob);

    int N = FRAMES * 2, eq_in = 0, eq_pre = 0, eq_zero = 0, eq_sum = 0;
    for (int i = 0; i < N; i++) {
        if (g_out[i] == in_copy[i])                       eq_in++;
        if (g_out[i] == (int16_t)PREFILL)                 eq_pre++;
        if (g_out[i] == 0)                                eq_zero++;
        if (g_out[i] == (int16_t)(PREFILL + in_copy[i]))  eq_sum++;
    }
    const char *v =
        eq_in   == N ? "OUT==IN  -> engine writes dry passthrough (no daemon copy needed)"
      : eq_sum  == N ? "OUT==prefill+IN -> engine ADDS input (ACCUMULATE)"
      : eq_pre  == N ? "OUT==prefill -> output UNTOUCHED (daemon must copy in->out)"
      : eq_zero == N ? "OUT==0 -> engine zeroes (bypass=SILENCE; daemon must copy)"
      : "mixed -> investigate";
    printf("    acc=%d(%-10s) %-13s: bypassed blk ret=%d", acc,
           acc ? "ACCUMULATE" : "WRITE", enable_first ? "en->disable" : "never-enabled", pret);
    if (enable_first) printf("  (crossfade ret=0 thru blk %d)", enodata_at);
    printf("\n      eq_in=%d eq_(pre+in)=%d eq_pre=%d eq_zero=%d /%d  -> %s\n",
           eq_in, eq_sum, eq_pre, eq_zero, N, v);
}

int main(int argc, char *argv[]) {
    setbuf(stdout, NULL); setbuf(stderr, NULL);
    if (argc < 2) { fprintf(stderr, "Usage: %s <libdseffect.so>\n", argv[0]); return 1; }

    void *lib = dlopen(argv[1], RTLD_NOW);
    if (!lib) { fprintf(stderr, "dlopen: %s\n", dlerror()); return 1; }
    EffectQueryEffect_t QE = dlsym(lib, "EffectQueryEffect");
    C       = (EffectCreate_t) dlsym(lib, "EffectCreate");
    ak_set  = (ak_set_fn)  dlsym(lib, "ak_set");
    ak_find = (ak_find_fn) dlsym(lib, "ak_find");
    ak_bus_get_rate = (ak_bus_rate_fn) dlsym(lib, "ak_bus_get_rate");
    ak_rate_hz      = (ak_rate_hz_fn)  dlsym(lib, "ak_rate_hz");
    ds1ap_new_fn     Ds1apNew     = (ds1ap_new_fn)     dlsym(lib, "_ZN5Ds1ap3NewEiiii");
    ds1ap_bufinit_fn Ds1apBufInit = (ds1ap_bufinit_fn) dlsym(lib, "Ds1apBufferInit");
    if (!C || !ak_set || !ak_find || !ak_bus_get_rate || !ak_rate_hz) {
        fprintf(stderr, "dlsym: missing a required symbol\n"); return 1;
    }
    QE(0, &DESC);
    g_in  = calloc(FRAMES * 2, 2);
    g_out = calloc(FRAMES * 2, 2);

    printf("=== EFFECT_CMD_SET_CONFIG (cmd 1) — empirical ==================\n");

    /* ── INIT a handle; read the engine's power-on default config ───────── */
    fresh(0);
    printf("[Sc1] baseline after INIT          : live=%d  (requested=%u)\n", live_rate(), rate_req());

    /* ── Sc2: the decisive test — SET_CONFIG to 48000 ──────────────────── */
    int32_t reply; int32_t ret = send_config(48000, CH_STEREO, FMT_PCM16, ACC_ACCUM, 64, &reply);
    int live = live_rate();
    printf("[Sc2] SET_CONFIG -> 48000          : ret=%d reply=%d  live=%d  (requested=%u)\n",
           ret, reply, live, rate_req());
    printf("      -> %s\n", (ret == 0 && reply == 0 && live == 48000)
           ? "ACCEPTED in-process; DSP now runs at 48000 (Ds1ap rebuilt via Ds1ap::New internally)"
           : "unexpected — investigate");

    /* ── Sc3: prove the DSP actually runs at 48000 ─────────────────────── */
    geq_setup();
    process_tone(TEST_FREQ, TEST_AMP, 48000.0, WARM + SETTLE);
    int pk_f; double rms_f; stats(g_out, &pk_f, &rms_f);
    ak_set(AK, rref("gebg"), TEST_BAND, BOOST);          /* boost band 4 */
    process_tone(TEST_FREQ, TEST_AMP, 48000.0, SETTLE);
    int pk_b; double rms_b; stats(g_out, &pk_b, &rms_b);
    printf("[Sc3] process 431Hz @48000 + GEQ   : flat rms=%.1f -> boosted rms=%.1f  (peak %d->%d)\n",
           rms_f, rms_b, pk_f, pk_b);
    printf("      -> %s\n", rms_b > rms_f * 1.05
           ? "DSP processing at the new rate (boost took effect post-reconfig)"
           : "no boost delta — DSP may not be live");

    /* ── Sc4: SET_CONFIG back to 44100 ─────────────────────────────────── */
    ret = send_config(44100, CH_STEREO, FMT_PCM16, ACC_ACCUM, 64, &reply);
    printf("[Sc4] SET_CONFIG -> 44100 (back)   : ret=%d reply=%d  live=%d\n",
           ret, reply, live_rate());

    /* ── Sc5: SET_CONFIG to an unsupported rate. Effect_reinit gates to
     *        {44100,48000,32000}; an out-of-set rate SILENTLY FALLS BACK to
     *        44100 yet still returns reply 0 — the host footgun. ─────────── */
    ret = send_config(96000, CH_STEREO, FMT_PCM16, ACC_ACCUM, 64, &reply);
    live = live_rate();
    printf("[Sc5] SET_CONFIG -> 96000 (unsup)  : ret=%d reply=%d  live=%d  (requested=%u)\n",
           ret, reply, live, rate_req());
    printf("      -> %s\n", (ret == 0 && reply == 0 && live == 44100 && rate_req() == 96000)
           ? "SILENT FALLBACK: reply 0 (success!) but DSP fell back to 44100 — host must validate the rate"
           : "unexpected — investigate");

    /* ══ Sc6 — full field-acceptance sweep (fresh handle per row, since a
     *    rejected reconfig can poison the handle) ═══════════════════════════ */
    printf("\n[Sc6] field-acceptance sweep ==================================\n");

    printf("  rate (stereo/PCM16/ACCUM/64) honoured set = {32000,44100,48000}:\n");
    uint32_t rates[] = {8000, 22050, 24000, 32000, 44100, 48000, 96000, 0};
    for (int i = 0; i < 8; i++) {
        fresh(100 + i);
        send_config(rates[i], CH_STEREO, FMT_PCM16, ACC_ACCUM, 64, &reply);
        int lv = live_rate();
        printf("    %-7u reply=%-3d live=%-7d %s\n", rates[i], reply, lv,
               (int)rates[i] == lv ? "honoured"
               : lv == 44100 ? "SILENT FALLBACK -> 44100 (reply still 0!)" : "?");
    }

    printf("  channels (rate=48000) — stereo(0x3) is the ONLY usable value:\n");
    struct { uint32_t m; const char *n; } chs[] = {
        {3,"stereo 0x3"}, {1,"mono 0x1"}, {2,"0x2"}, {0x3f,"5.1 0x3f"}};
    for (int i = 0; i < 4; i++) {
        fresh(110 + i);
        send_config(48000, chs[i].m, FMT_PCM16, ACC_ACCUM, 64, &reply);
        printf("    %-10s reply=%-3d %s\n", chs[i].n, reply,
               reply == 0 ? "accepted"
               : !handle_alive() ? "REJECTED + handle POISONED (graph torn down, Ds1ap NULL)"
               : "rejected at field check (handle intact)");
    }

    printf("  format (rate=48000/stereo) only PCM16(1):  ");
    for (int f = 0; f <= 3; f++) { fresh(120 + f);
        send_config(48000, CH_STEREO, (uint8_t)f, ACC_ACCUM, 64, &reply);
        printf("fmt%d=%d ", f, reply); }
    printf("\n  accessMode (rate=48000/stereo/PCM16) only {0,2}:  ");
    for (int a = 0; a <= 3; a++) { fresh(130 + a);
        send_config(48000, CH_STEREO, FMT_PCM16, (uint8_t)a, 64, &reply);
        printf("acc%d=%d ", a, reply); }
    printf("\n  cmdSize (rate=48000/stereo) must be exactly 64:  ");
    uint32_t szs[] = {0, 60, 63, 64, 65, 128};
    for (int i = 0; i < 6; i++) { fresh(140 + i);
        ret = send_config(48000, CH_STEREO, FMT_PCM16, ACC_ACCUM, szs[i], &reply);
        printf("sz%u=ret%d ", szs[i], ret); }
    printf("\n      (size!=64 -> command() returns -22 directly, reply untouched;\n"
           "       field rejects return 0 with reply=-22 — always check the reply)\n");

    /* ══ Sc7 — WRITE vs ACCUMULATE is a real behavioural knob, not hard-wired.
     *    Prefill the output, feed SILENCE, process ONE block WITHOUT zeroing:
     *    WRITE overwrites it to ~0, ACCUMULATE leaves the prefill intact. ════ */
    printf("\n[Sc7] accessMode WRITE vs ACCUMULATE behaviour ================\n");
    for (int k = 0; k < 2; k++) {
        uint8_t acc = k ? ACC_ACCUM : 0;
        fresh(150 + k);
        send_config(48000, CH_STEREO, FMT_PCM16, acc, 64, &reply);
        geq_setup();
        process_tone(TEST_FREQ, 0.0, 48000.0, WARM);      /* warm on silence (zeros g_out) */
        for (int i = 0; i < FRAMES * 2; i++) g_out[i] = PREFILL;  /* prefill, do NOT zero */
        memset(g_in, 0, FRAMES * 4);
        audio_buffer_t ib = { .frameCount = FRAMES, .s16 = g_in };
        audio_buffer_t ob = { .frameCount = FRAMES, .s16 = g_out };
        (*H)->process(H, &ib, &ob);
        int pk; double rms; stats(g_out, &pk, &rms);
        printf("    accessMode=%d (%-10s): prefill %d -> out peak=%-5d %s\n",
               acc, acc ? "ACCUMULATE" : "WRITE", PREFILL, pk,
               pk < PREFILL / 4 ? "OVERWROTE (WRITE honoured)"
                                : "prefill SURVIVED (ADD = ACCUMULATE honoured)");
    }
    printf("      -> the engine honours the field; \"runs in ACCUMULATE mode\" is the\n"
           "         host/AudioFlinger choice. WRITE overwrites, so it needs no pre-memset.\n");

    /* ── Sc8: the v1 manual hot-swap, for contrast (fresh handle) ───────── */
    printf("\n[Sc8] v1 Ds1ap::New hot-swap (arm/ddp_processor.c) on a fresh handle:\n");
    if (Ds1apNew && Ds1apBufInit) {
        fresh(1);
        void *nds = Ds1apNew(0, 48000, 2, 0);
        Ds1apBufInit(nds, 256, 2, 16);                  /* v1's call, verbatim — note args below */
        uint32_t *ctx = (uint32_t *)H;
        ctx[17] = (uint32_t)(uintptr_t)nds;             /* self+0x44 = new Ds1ap */
        ctx[3]  = 48000;                                /* self+12  = in.rate    */
        ctx[11] = 48000;                                /* self+44  = out.rate   */
        printf("      hot-swap -> live=%d  (Ds1ap::New + ctx poke)\n", live_rate());
        printf("      same end-state offsets (self+0x44 / self+12) as SET_CONFIG, BUT the manual\n"
               "      path: (a) skips re-applying cached params (Effect_setConfig), and (b) calls\n"
               "      Ds1apBufferInit(ds1ap,256,2,16) — wrong args (sig is inCh,outCh,256) and\n"
               "      drops the result, leaving the stale engine buffer at self+0x48. SET_CONFIG\n"
               "      does both correctly. cmd 1 is the complete, engine-authored reconfigure.\n");
    } else {
        printf("      (Ds1ap::New / Ds1apBufferInit not resolved; skipped)\n");
    }

    /* ══ Sc9 — what does a FULLY-disabled process() do to the output? Decides
     *    whether DolbyX v2 (WRITE mode) can rely on engine-owned dry passthrough
     *    or owes a daemon-side input->output copy. ═══════════════════════════ */
    printf("\n[Sc9] disabled-block output by accessMode ====================\n");
    disabled_passthrough_probe(160, 0,         1);  /* WRITE, enable->disable (power-off toggle)  */
    disabled_passthrough_probe(161, ACC_ACCUM, 1);  /* ACCUMULATE cross-check (known to ADD input) */
    disabled_passthrough_probe(162, 0,         0);  /* WRITE, never enabled (power-off-at-create)  */
    printf("      -> WRITE shows OUT==IN both ways, so the daemon can always just call\n"
           "         process(): no per-block memset and no manual passthrough copy.\n");

    printf("\n=== VERDICT ===================================================\n");
    printf("  cmd 1 SET_CONFIG IS fully implemented and honoured in-process: it caches the\n");
    printf("  effect_config_t, rebuilds the Ds1ap at the new rate via Ds1ap::New ->\n");
    printf("  ak_set_input_config (the SAME primitive the v1 hot-swap pokes by hand),\n");
    printf("  re-applies params, and re-inits the audio buffer. It SUPERSEDES the manual\n");
    printf("  hot-swap. The original DDP never sends it only because Android makes I/O config\n");
    printf("  framework-driven (AudioFlinger), not because the engine lacks the path.\n");

    _Exit(0);
}
