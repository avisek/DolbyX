/*
 * ddp_probe.c — Evidence harness for libdseffect.so engine behavior.
 *
 * Runs ten focused experiments under qemu-arm-static and prints
 * stdout summaries while the engine's own log lines (via the noisy
 * liblog_stub.c) print to stderr. The combination is the empirical
 * source-of-truth for the claims in:
 *
 *   docs/ddp/02-ak-parameters.md
 *   docs/ddp/03-binary-protocol.md
 *   docs/ddp/05-profiles-and-persistence.md
 *   docs/ddp/07-ak-api.md
 *   docs/REARCHITECTURE_PLAN.md
 *
 * Experiments
 * -----------
 *   1. Init handshake (DEFINE_PARAMS + DEFINE_SETTINGS with all 64
 *      params + VISUALIZER_ENABLE + ENABLE). Also exercises cmd 7
 *      GET to confirm the host can read back the visualizer-enable
 *      bit.
 *   2. Two parameter stores: a cmd 3 SET writes the RAW value to the
 *      settings cache (reply 0, no protocol validation) but ak_set
 *      CLAMPS the forwarded copy into the AK registry. Reads both back
 *      (cache vs ak_get) on over-range writes to show the split.
 *   3. Cmd 3 GET unimplemented: try a flat-index GET, observe reply -22;
 *      ak_get (see #9) is the real getter.
 *   4. cmd 4 VISUALIZER_DATA returns dynamic vcbg||vcbe. Captured
 *      twice — once after warm-up and once at the end of section 7
 *      after audio shape has changed — to show the DSP refreshes
 *      both slots block-to-block.
 *   5. cmd 6 VERSION returns the engine version.
 *   6. ENABLE/DISABLE crossfade + idempotency; a measured check that a
 *      SET on either side of the cycle takes effect (cache + AK state
 *      survive); Test A — process() runs in ACCUMULATE mode on a
 *      disabled (-ENODATA) block (out = prior + input); Test B —
 *      process() clobbers its own input buffer in both states (enabled
 *      leaves that block's processed output, stable across blocks).
 *   7. Behavioral sweep: dvla, vmb past their declared max. The DSP
 *      reads the CLAMPED registry, not the raw cache — proven by a
 *      direct cache poke (registry frozen) that leaves the output
 *      unchanged. Over-max sweep pairs stop diverging because ak_set
 *      clamps both to the engine max (vmb=240, 480 -> 192; dvla=10,
 *      200 -> 10); the exact clamped values are read via ak_get in #2.
 *   8. Out-of-cache flat-index SET (proves the engine's only SET-side
 *      validation is index-range), the boundary case
 *      `begin + count > cache_total` (resolves whether the engine
 *      checks only `begin` or the full extent), and bogus 4-CC
 *      DEFINE_PARAMS acceptance (proves no name validation).
 *   9. AK registry via the engine's own ak_get: reproduces cmd 4 (both
 *      vcbg gains and vcbe excitations, same source); vnbg/vnbe are live
 *      but mirror vcbg/vcbe; ak_get_min/max expose the engine's true
 *      ranges (vmb, vol differ from the table); a runtime value-diff
 *      shows only the visualizer slots change during process().
 *  10. Java param-set discrepancy: set-diff the engine's real root leaves
 *      against the host's DEFINE_PARAMS list (G[], verbatim DsAkSettings) —
 *      surfaces the mismatch without assuming it. Java lists two phantoms
 *      (mxou/lcsz) that aren't root leaves, so their flat registration gets
 *      ref 0 — dead, the write is dropped (they're node params; see dump
 *      tree) — and omits two real root leaves (scpe/test). Correct host set =
 *      Java's 64 − phantoms + omitted.
 *
 * Dump mode (no experiments) — the engine's own AK tree is the authoritative
 * param table, so these walk it instead of trusting the host list:
 *   ddp_probe <lib> dump tree      full object tree, branch-drawn: every leaf's
 *                                  type/flags/size/off/len/range/frac + descriptions
 *   ddp_probe <lib> dump defaults  each root param's power-on default (4-CC = value)
 *   ddp_probe <lib> dump types     root leaves as a flat table + write-protect probe
 *   ddp_probe <lib> dump docs      every def's name · description · long help (idx 2),
 *                                  rule-divided; the only dump that shows the help text
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
 * Order matches DEFINE_PARAMS index assignment expected by the engine.
 * These bounds are the JAVA view: experiment 9c deliberately diffs them
 * against the engine's true ranges (ak_get_min/max) to surface where they
 * disagree (vmb, vol). Do NOT "correct" them to the engine values — that
 * erases 9c's finding. */
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

/* ── Engine AK API — read the live AK registry ───────────────────────
 * cmd 4 fetches visualizer state from this same registry with ak_get_bulk
 * (the per-element ak_get lines in the engine log are that bulk call's
 * internal loop, not separate calls);
 * these are the same exported symbols, reachable from fixed offsets in
 * the effect context. The registry is the store the DSP actually
 * reads/writes — the +0xb0 settings cache is a raw host-side mirror the
 * DSP ignores (proven in experiments 2 and 9). Resolved by ak_attach()
 * once the init handshake has built the schema.
 *
 *   handle  = *(void**)(*(void**)(H + 0x44))   pDs1ap, double-deref
 *   AK_REF  = *(uint32_t**)(H + 0xb4)           tagged refs, DEFINE_PARAMS order
 *
 * ak_get(h, ref, elem)              -> one value, clamped to the engine range
 * ak_get_bulk(h, ref, 0, n, 4, dst) -> n int16s (stride 4 = the int16 form;
 *                                      stride 1 would give int32 elements)
 * ak_get_name(h, ref)               -> 4-CC packed little-endian in a uint32
 * ak_get_min/max(h, ref)            -> engine's declared range for the param
 * ak_get_length(h, ref)            -> array element count for the param
 * ak_get_frac_bits(h, ref)         -> fixed-point fractional bits (unit = 1/2^n)
 * ak_get_string(h, ref, 0, idx)     -> display string: idx 0 name, 1 desc, 2 help
 * ak_enum(h, parent_ref, i)         -> i-th child ref of parent (root = ref 1),
 *                                      0 past the last child (dump mode)
 * ak_find(h, parent_ref, packed4cc) -> child ref by name, 0 if absent (exp 10) */
typedef int      (*ak_get_fn)(void *, uint32_t, int);
typedef int      (*ak_get_bulk_fn)(void *, uint32_t, int, int, int, void *);
typedef uint32_t (*ak_get_name_fn)(void *, uint32_t);
typedef int      (*ak_minmax_fn)(void *, uint32_t);
typedef uint32_t (*ak_enum_fn)(void *, uint32_t, int);
typedef uint32_t (*ak_find_fn)(void *, uint32_t, uint32_t);
typedef char *   (*ak_get_string_fn)(void *, uint32_t, int, int);
static ak_get_fn      ak_get;
static ak_get_bulk_fn ak_get_bulk;
static ak_get_name_fn ak_get_name;
static ak_minmax_fn   ak_get_min, ak_get_max;
static ak_minmax_fn   ak_get_length, ak_get_frac_bits;
static ak_enum_fn     ak_enum;
static ak_find_fn     ak_find;
static ak_get_string_fn ak_get_string;

/* Per-param metadata the engine ALSO exposes (see 07-ak-api). ak_get_type → the
 * def's type tag; ak_get_flags → the instance flag word (bit 0x2 = write-protected);
 * ak_get_size/offset write the byte size / struct offset through an out-param.
 * ak_set is the PUBLIC writer — clamps, and HONORS the write-protect bit 0x2
 * (returns 0 on a read-only leaf, storing nothing); ak_set_internal is the engine's
 * forcing writer that bypasses it (how the DSP writes computed slots). */
typedef int (*ak_getout_fn)(void *, uint32_t, int *);
typedef int (*ak_set_fn)(void *, uint32_t, int, int);
static ak_minmax_fn ak_get_type, ak_get_flags;
static ak_getout_fn ak_get_size, ak_get_offset;
static ak_set_fn    ak_set, ak_set_internal;

static void     *AK;       /* engine AK handle */
static uint32_t *AK_REF;   /* per-param tagged refs (DEFINE_PARAMS order) */
static int       g_quiet;  /* dump mode: silence the init-handshake chatter */

static void ak_attach(void) {
    void *pDs1ap = *(void **)((char *)H + 0x44);
    AK     = *(void **)pDs1ap;
    AK_REF = *(uint32_t **)((char *)H + 0xb4);
}
static uint32_t ak_ref(const char *name) {
    int p = find_param(name);
    return p < 0 ? 0 : AK_REF[p];
}
/* Live registry value of param `name` element `elem` — what the DSP uses. */
static int ak_get_param(const char *name, int elem) {
    return ak_get(AK, ak_ref(name), elem);
}
/* Decode ak_get_name's packed 4-CC into a C string (buf >= 5 bytes). */
static void ak_fourcc(uint32_t f, char *buf) {
    buf[0] = f; buf[1] = f >> 8; buf[2] = f >> 16; buf[3] = f >> 24; buf[4] = 0;
}
/* Pack a 4-CC into the engine's little-endian uint32 form (inverse of
 * ak_fourcc) — what ak_find expects for a name. */
static uint32_t pack_fourcc(const char *s) {
    uint32_t f = 0;
    for (int i = 0; i < 4 && s[i]; i++) f |= (uint32_t)(uint8_t)s[i] << (8 * i);
    return f;
}

/* Snapshot every param's live registry value into a cache-flat int[] (indexed
 * by settings_begin[], which every param has since all are in DEFINE_SETTINGS).
 * ak_ref is resolved once per param, not once per element. Params absent from
 * the AK registry (ref 0, e.g. mxou/lcsz) read as 0. */
static void snapshot_registry(int *dst) {
    for (int i = 0; i < NPARAM; i++) {
        uint32_t ref = ak_ref(G[i].name);
        for (int e = 0; e < G[i].len; e++)
            dst[settings_begin[i] + e] = ref ? ak_get(AK, ref, e) : 0;
    }
}

/* ak_get_string(idx), or "" if the engine has none / the symbol is absent.
 * idx 0 = display name, 1 = one-line description, 2 = long help. */
static const char *ak_str(uint32_t ref, int idx) {
    const char *s = ak_get_string ? ak_get_string(AK, ref, 0, idx) : NULL;
    return s ? s : "";
}

/* `dump tree`: walk the engine's AK object tree from `parent` (root = ref 1),
 * printing each def's authoritative metadata + name + description straight from
 * the engine — no host table. Leaves carry the FULL per-param detail (the same
 * fields as `dump types`: type/flags/size/offset on top of len/range/frac).
 * `prefix` is the accumulated branch art (│ / blanks) for the ancestor columns;
 * `last` (peeked from the next sibling) picks └─ vs ├─. A ref with children is a
 * DSP node and recurses; the depth/count caps guard a mis-resolved ref looping. */
static void dump_tree(uint32_t parent, const char *prefix, int depth, int *n) {
    for (int i = 0; ; i++) {
        uint32_t r = ak_enum(AK, parent, i);
        if (!r || depth > 8 || ++*n > 400) return;
        /* spacer before each item (keeps │ unbroken) — incl. parent→first-child at
         * depth>0, but not above the very first root item. */
        if (i > 0 || depth > 0) printf("%s│\n", prefix);
        int last = (ak_enum(AK, parent, i + 1) == 0);
        const char *branch = last ? "└─ " : "├─ ";
        const char *cont   = last ? "   " : "│  ";   /* ancestor column past us */
        char fc[5]; ak_fourcc(ak_get_name(AK, r), fc);
        int flags = ak_get_flags(AK, r), node = ak_enum(AK, r, 0) != 0;
        printf("%s%s%-4s  %s%s\n", prefix, branch, fc, ak_str(r, 0),
               node ? "  [node]" : "");
        if (!node) {
            int size = -1, off = -1;
            if (ak_get_size)   ak_get_size(AK, r, &size);
            if (ak_get_offset) ak_get_offset(AK, r, &off);
            printf("%s%s      type=%d len=%-3d size=%-4d off=%-6d "
                   "[%d .. %d] frac=%d  flags=0x%04x%s\n",
                   prefix, cont, ak_get_type(AK, r), ak_get_length(AK, r),
                   size, off, ak_get_min(AK, r), ak_get_max(AK, r),
                   ak_get_frac_bits(AK, r), flags & 0xffff,
                   (flags & 2) ? "  read-only" : "");
        }
        const char *desc = ak_str(r, 1);
        if (*desc) printf("%s%s      %s\n", prefix, cont, desc);
        if (node) {
            char sub[256];
            snprintf(sub, sizeof sub, "%s%s", prefix, cont);
            dump_tree(r, sub, depth + 1, n);
        }
    }
}

/* `dump defaults`: each ROOT leaf's power-on default (4-CC = value...). Root
 * leaves are the host-addressable set — the correct one: scpe/test included,
 * mxou/lcsz absent (they're node params). Read straight after open, before any
 * SET, so the AK registry still holds the engine's intrinsic defaults. */
static void dump_defaults(void) {
    printf("# engine power-on defaults — root params, before any SET\n");
    for (int i = 0; i < 400; i++) {
        uint32_t r = ak_enum(AK, 1, i);
        if (!r) break;
        if (ak_enum(AK, r, 0)) continue;            /* skip nodes — root leaves only */
        char fc[5]; ak_fourcc(ak_get_name(AK, r), fc);
        int len = ak_get_length(AK, r);
        printf("%-4s =", fc);
        for (int e = 0; e < len; e++) printf(" %d", ak_get(AK, r, e));
        printf("\n");
    }
}

static int set_param(const char *name, int offset, const int16_t *v, int c); /* defined below */

/* `dump types`: per ROOT LEAF, the engine's full per-param metadata beyond
 * len/range/frac — the def's `type` tag, the instance `flags` word, byte `size`,
 * and struct `offset`. type 3 = a normal addressable value (inline storage, real
 * range); type 2 = an opaque/by-reference slot (size 0, full-int16 range) — the
 * build/version/license blobs and the visualizer-output arrays. The flags answer
 * "is this param read-only at the engine level": bit 0x2 = write-protected (public
 * ak_set/ak_set_bulk return 0 and store nothing; only ak_set_internal can write). */
static void dump_types(void) {
    printf("# root leaves — engine per-param metadata (type/flags/size/len/offset)\n");
    printf("# type: 3=value(inline) 2=opaque/by-ref ; flags: 0x2=write-protect(read-only) "
           "0x1000=inline-storage 0x8000=on most simple knobs (0x1/0x4/0x20 on every def)\n");
    printf("%-4s %4s %6s %-6s %4s %4s %4s %7s %7s %4s\n",
           "name", "type", "flags", "rdonly", "size", "len", "off", "min", "max", "frac");
    for (int i = 0; i < 400; i++) {
        uint32_t r = ak_enum(AK, 1, i);
        if (!r) break;
        if (ak_enum(AK, r, 0)) continue;            /* leaves only, like dump_defaults */
        char fc[5]; ak_fourcc(ak_get_name(AK, r), fc);
        int flags = ak_get_flags(AK, r), size = -1, off = -1;
        if (ak_get_size)   ak_get_size(AK, r, &size);
        if (ak_get_offset) ak_get_offset(AK, r, &off);
        printf("%-4s %4d 0x%04x %-6s %4d %4d %4d %7d %7d %4d\n",
               fc, ak_get_type(AK, r), flags & 0xffff,
               (flags & 2) ? "YES" : "-", size, ak_get_length(AK, r), off,
               ak_get_min(AK, r), ak_get_max(AK, r), ak_get_frac_bits(AK, r));
    }
}

static void doc_rule(void) { for (int k = 0; k < 78; k++) fputs("─", stdout); putchar('\n'); }

/* `dump docs`: every def's human-readable strings — display name (idx 0), one-line
 * description (idx 1), and the long help (idx 2) that no other dump surfaces. Walks
 * the WHOLE tree (nodes + leaves, every def) in tree order; `path` is the parent
 * 4-CC chain (a/b/c) so repeated names (26 `ver`s, 21 `on`s …) stay distinguishable
 * without tree art. Strings print verbatim — the engine's own newlines structure the
 * help, the terminal soft-wraps the rest. Pure strings: type/range/flags are in
 * `dump tree`/`dump types`. Each def: a rule, `path · name` (` · name` dropped when it
 * equals the 4-CC), the `desc:` line, then a blank line + the help — desc/help only
 * when present, so a doc-less internal leaf is just its path. */
static void dump_docs(uint32_t parent, const char *path, int depth, int *n, int *nh) {
    for (int i = 0; ; i++) {
        uint32_t r = ak_enum(AK, parent, i);
        if (!r || depth > 8 || ++*n > 400) return;
        char fc[5]; ak_fourcc(ak_get_name(AK, r), fc);
        char here[256];
        snprintf(here, sizeof here, "%s%s%s", path, *path ? "/" : "", fc);
        const char *name = ak_str(r, 0), *desc = ak_str(r, 1), *help = ak_str(r, 2);
        doc_rule();
        if (*name && strcmp(name, fc)) printf("%s · %s\n", here, name);
        else                           printf("%s\n", here);
        if (*desc) printf("desc: %s\n", desc);
        if (*help) { printf("\n%s\n", help); (*nh)++; }
        if (ak_enum(AK, r, 0)) dump_docs(r, here, depth + 1, n, nh);
    }
}

/* Resolve a 4-CC straight from the engine tree (root = ref 1), so params the host
 * G[] omits (scpe/test) still resolve. Falls back to the host ref for names in G[]. */
static uint32_t leaf_ref(const char *name) {
    uint32_t r = ak_ref(name);
    if (!r && ak_find) r = ak_find(AK, 1, pack_fourcc(name));
    return r;
}

/* Write-protection probe. Runs in dump mode: NO process() has run, so the DSP can't
 * clobber — this isolates the engine's flag-level protection from the runtime
 * overwrite of vcbg/vcbe. Each param is hit by all three write paths with a distinct
 * in-range target (the registry is reset to the default via the forcing internal
 * setter between paths), and the readback says whether the write actually landed:
 *   - public ak_set      — clamps AND honors write-protect (returns the stored value,
 *                          or 0 on reject); a read-only leaf is left UNCHANGED.
 *   - ak_set_internal    — forces past it (how the DSP writes computed slots);
 *                          still bounded by storage length (type-2 leaves are len-0).
 *   - cmd 3 SET          — the real host/protocol path; resolves whether PRODUCTION
 *                          can overwrite a protected param.
 * Each cell shows the readback verdict + that path's raw return — the stored (clamped)
 * value on success, 0 (never -4) on a read-only reject; the cmd 3 reply is 0 either way. */
static void probe_write_protect(void) {
    /* dvla = plain settable control; vnnb = type-3 read-only WITH storage (the clean
     * case); vcbg/vcbe = type-2 read-only, len-0 visualizer outputs; vcnb = settable
     * visualizer config; scpe = real root leaf the host omits. */
    const char *names[] = { "dvla", "vnnb", "vcbg", "vcbe", "vcnb", "scpe", NULL };
    printf("\n# write-protection — three write paths: post-write readback + raw return.\n");
    printf("# public ak_set/ak_set_internal return the stored (clamped) value on success,\n"
           "# 0 (unchanged) on a read-only reject — never -4; the cmd 3 reply is 0 either\n"
           "# way, so only the readback reveals a rejection.\n");
    printf("%-4s %4s %6s  %-18s %-18s %-18s\n",
           "name", "type", "flags", "ak_set", "ak_set_internal", "cmd3 SET");
    for (int i = 0; names[i]; i++) {
        const char *nm = names[i];
        uint32_t r = leaf_ref(nm);
        if (!r) { printf("%-4s  (ref 0 — unresolved)\n", nm); continue; }
        int flags = ak_get_flags(AK, r), mn = ak_get_min(AK, r), mx = ak_get_max(AK, r);
        int def = ak_get(AK, r, 0);
        int t = (mx > def) ? mx : mn;               /* a legal value != default */
        if (t == def) t = (mn != def) ? mn : mx;
        #define RESET() (ak_set_internal ? ak_set_internal(AK, r, 0, def) : 0)
        int rp = ak_set(AK, r, 0, t);          int a_pub = ak_get(AK, r, 0); RESET();
        int ri = ak_set_internal(AK, r, 0, t); int a_int = ak_get(AK, r, 0); RESET();
        /* cmd 3 only reaches params with a cache slot (every G[] entry has one). */
        int in_G = find_param(nm) >= 0, rc = 0;
        if (in_G) rc = set_param(nm, 0, &(int16_t){ (int16_t)t }, 1);
        int a_cmd = ak_get(AK, r, 0);          RESET();
        #undef RESET
        /* verdict (readback) + the raw return value that proves it */
        char cp[24], ci[24], cc[24];
        snprintf(cp, sizeof cp, "%-6s ret=%d", a_pub == t ? "wrote" : "reject", rp);
        snprintf(ci, sizeof ci, "%-6s ret=%d", a_int == t ? "force" : "=def",   ri);
        if (in_G) snprintf(cc, sizeof cc, "%-6s reply=%d", a_cmd == t ? "wrote" : "reject", rc);
        else      snprintf(cc, sizeof cc, "n/a (not in G[])");
        printf("%-4s %4d 0x%04x  %-18s %-18s %-18s %s\n",
               nm, ak_get_type(AK, r), flags & 0xffff, cp, ci, cc,
               (flags & 2) ? "[read-only]" : "");
    }
}

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
    if (!g_quiet) printf("DEFINE_PARAMS (%d names) -> reply=%d\n", NPARAM, r);
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
    if (!g_quiet)
        printf("DEFINE_SETTINGS (all 64 params, %d slots, %d bytes) "
               "-> reply=%d\n", total, byte_size, r);
    free(buf);
    return total;
}

/* Refill a fresh sine into an interleaved-stereo int16 buffer. A real
 * audio host hands the engine a NEW PCM buffer every block, and
 * process() clobbers its input (Test B), so any caller that measures an
 * output — or warms the DSP toward a steady state — must refill first. */
static void fill_sine(int16_t *pcm, int frames, double rate,
                      double amp, double freq) {
    for (int i = 0; i < frames; ++i) {
        int s = (int)(amp * sin(2.0 * M_PI * freq * (i / rate)));
        pcm[i*2] = (int16_t)s; pcm[i*2+1] = (int16_t)s;
    }
}

/* Stream N blocks of a fresh 440 Hz / amp-20000 sine. Refilling each
 * iteration is essential: process() clobbers its input (Test B), so
 * without a refill the buffer decays to the noise floor within a few
 * blocks and every downstream measurement reads silence. Output is
 * zeroed per block (the engine ACCUMULATEs into it). */
static void process_blocks(int16_t *in_pcm, int16_t *out_pcm, int frames,
                           int n) {
    for (int i = 0; i < n; ++i) {
        fill_sine(in_pcm, frames, 44100.0, 20000.0, 440.0);
        audio_buffer_t in  = { .frameCount = (uint32_t)frames, .s16 = in_pcm };
        audio_buffer_t out = { .frameCount = (uint32_t)frames, .s16 = out_pcm };
        memset(out_pcm, 0, frames * 4);
        (*H)->process(H, &in, &out);
    }
}

/* Print peak + RMS of an interleaved int16 buffer (input or output). */
static void measure(const char *label, const int16_t *buf, int frames) {
    int peak = 0; double ss = 0;
    for (int i = 0; i < frames * 2; ++i) {
        int v = buf[i];
        int a = v < 0 ? -v : v;
        if (a > peak) peak = a;
        ss += (double)v * v;
    }
    double rms = sqrt(ss / (frames * 2));
    printf("    %-32s peak=%5d rms=%8.1f\n", label, peak, rms);
}

static int diff_count(const int16_t *a, const int16_t *b, int n) {
    int d = 0;
    for (int i = 0; i < n; ++i) if (a[i] != b[i]) ++d;
    return d;
}

/* ── Settings cache (raw host-side mirror) ────────────────────────────
 * cmd 3 SET writes the RAW value here — a flat int16[cache_total] the
 * engine keeps at a fixed offset (H + 0xb0), found by disassembling the
 * cmd-3 cache-create path. It is NOT what the DSP reads: the DSP acts on
 * the clamped AK registry (ak_get), so the cache and the registry diverge
 * on any out-of-range write — experiment 2 reads both to show the split.
 * libdseffect.so is its EOL build, so the offset is frozen. */
#define CACHE_PTR_OFFSET 0xb0
static const int16_t *find_cache(void) {
    return *(const int16_t **)((char *)H + CACHE_PTR_OFFSET);
}

int main(int argc, char *argv[]) {
    setbuf(stdout, NULL);
    setbuf(stderr, NULL);
    if (argc < 2) {
        fprintf(stderr, "Usage: %s <libdseffect.so> [dump tree|defaults|types|docs]\n",
                argv[0]);
        return 1;
    }
    /* Dump mode walks the engine's own AK tree instead of running experiments;
     * silence the init-handshake chatter so stdout is a clean dump. */
    const char *dump_what = NULL;
    if (argc >= 3 && !strcmp(argv[2], "dump")) {
        dump_what = argc >= 4 ? argv[3] : "tree";
        g_quiet = 1;
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
    ak_get      = (ak_get_fn)      dlsym(lib, "ak_get");
    ak_get_bulk = (ak_get_bulk_fn) dlsym(lib, "ak_get_bulk");
    ak_get_name = (ak_get_name_fn) dlsym(lib, "ak_get_name");
    ak_get_min  = (ak_minmax_fn)   dlsym(lib, "ak_get_min");
    ak_get_max  = (ak_minmax_fn)   dlsym(lib, "ak_get_max");
    ak_enum          = (ak_enum_fn) dlsym(lib, "ak_enum");          /* dump + exp 10 */
    ak_get_length    = (ak_minmax_fn) dlsym(lib, "ak_get_length");
    ak_get_frac_bits = (ak_minmax_fn) dlsym(lib, "ak_get_frac_bits");
    ak_find          = (ak_find_fn) dlsym(lib, "ak_find");          /* exp 10 */
    ak_get_string    = (ak_get_string_fn) dlsym(lib, "ak_get_string"); /* dump tree */
    ak_get_type   = (ak_minmax_fn) dlsym(lib, "ak_get_type");      /* dump types */
    ak_get_flags  = (ak_minmax_fn) dlsym(lib, "ak_get_flags");
    ak_get_size   = (ak_getout_fn) dlsym(lib, "ak_get_size");
    ak_get_offset = (ak_getout_fn) dlsym(lib, "ak_get_offset");
    ak_set          = (ak_set_fn) dlsym(lib, "ak_set");
    ak_set_internal = (ak_set_fn) dlsym(lib, "ak_set_internal");
    if (!ak_get || !ak_get_bulk || !ak_get_name || !ak_get_min || !ak_get_max) {
        fprintf(stderr, "dlsym: libdseffect.so is missing an ak_* accessor "
                "(ak_get/ak_get_bulk/ak_get_name/ak_get_min/ak_get_max)\n");
        return 1;
    }
    uint32_t n = 0; Q(&n);
    effect_descriptor_t desc; QE(0, &desc);
    int32_t cr = C(&desc.uuid, 0, 0, &H);
    if (cr != 0 || !H) {
        fprintf(stderr, "EffectCreate failed (%d)\n", cr);
        return 1;
    }
    uint32_t rs = 4; int32_t r = 0;
    (*H)->command(H, EFFECT_CMD_INIT, 0, NULL, &rs, &r);
    if (!g_quiet) printf("EFFECT_CMD_INIT -> reply=%d\n", r);

    /* ── 1. Init handshake ──────────────────────────────────────── */
    if (!g_quiet) printf("\n=== 1. INIT HANDSHAKE ===\n");
    define_params();
    int cache_total = define_settings_all();
    ak_attach();   /* resolve the AK handle + per-param refs from the context */

    /* Dump mode: the registry holds the engine's power-on defaults here (no
     * SET yet) and the AK tree is fully built — walk it and exit. */
    if (dump_what) {
        if (!ak_enum) { fprintf(stderr, "dump: ak_enum not exported\n"); return 2; }
        if (!strcmp(dump_what, "tree")) {
            printf("# AK object tree — 4-CC / name; leaves: type, len/size/off, "
                   "[min..max], frac (1/2^frac), flags, description\n");
            printf("#   type 3=value 2=opaque/by-ref (6/7 = internal AK objects) ; "
                   "flags bit 0x2 = write-protect (read-only)\n\n");
            int n = 0; dump_tree(1, "", 0, &n);
            printf("\n# %d defs\n", n);
        } else if (!strcmp(dump_what, "defaults")) {
            dump_defaults();
        } else if (!strcmp(dump_what, "types")) {
            dump_types();
            probe_write_protect();
        } else if (!strcmp(dump_what, "docs")) {
            printf("# engine strings — every def's display name · one-line desc · long\n"
                   "# help (idx 2), the docs no other dump shows. Tree order; the `a/b/c`\n"
                   "# path crumb disambiguates repeated 4-CCs (26 ver, 21 on, 15 hdrm …).\n");
            int n = 0, nh = 0; dump_docs(1, "", 0, &n, &nh);
            doc_rule();
            printf("# %d defs, %d with help\n", n, nh);
        } else {
            fprintf(stderr, "dump: expected 'tree', 'defaults', 'types', or 'docs'\n");
            return 2;
        }
        return 0;
    }

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

    /* A 440 Hz sine (amp 20000) so the visualizer/DSP have material. */
    int frames = 256;
    int16_t *pcm_in  = calloc(frames * 2, 2);
    int16_t *pcm_out = calloc(frames * 2, 2);
    int16_t *in_ref  = calloc(frames * 2, 2);  /* saved input copy for Test A */
    double rate = 44100.0;
    fill_sine(pcm_in, frames, rate, 20000.0, 440.0);
    /* Warm up past the 7560-sample enable crossfade (~30 blocks of 256). */
    process_blocks(pcm_in, pcm_out, frames, 35);

    /* ── 2. TWO STORES — raw cache vs clamped AK registry ───────── */
    printf("\n=== 2. TWO STORES — cmd 3 SET: cache=raw, registry=clamped ===\n");
    printf("    cmd 3 SET writes the RAW value to the settings cache (reply 0,\n"
           "    no protocol validation) AND forwards to ak_set, which CLAMPS to\n"
           "    the engine's range. The DSP reads the clamped registry (see #7),\n"
           "    so an over-range write is silently clamped — ak_get reads it back.\n");
    {
        const int16_t *cache = find_cache();
        const char *probe2[] = { "dvla", "vmb", "dssa", "plmd", "arbl", "vol", NULL };
        for (int i = 0; probe2[i]; ++i) {
            const char *nm = probe2[i];
            int p = find_param(nm);
            if (!ak_ref(nm)) { printf("    %-4s: (not in AK)\n", nm); continue; }
            int16_t over = (int16_t)(G[p].hi + 200);
            int rep = set_param(nm, 0, &over, 1);
            printf("    %-4s: SET %-6d -> reply=%d  cache(raw)=%-6d  "
                   "ak_get(clamped)=%-5d  engine[%d..%d]\n",
                   nm, over, rep, cache[settings_begin[p]], ak_get_param(nm, 0),
                   ak_get_min(AK, ak_ref(nm)), ak_get_max(AK, ak_ref(nm)));
        }
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
               "     Returning -EINVAL(-22)')\n"
               "    ak_get is the real getter — reads it live: dvla=%d (see #9)\n",
               gs, out, ak_get_param("dvla", 0));
    }

    /* ── 4. cmd 4 VISUALIZER_DATA returns dynamic state ─────────── */
    int16_t vis_snapshot_a[40] = {0};
    printf("\n=== 4. cmd 4 VISUALIZER_DATA — returns vcbg||vcbe ===\n");
    {
        uint8_t empty[80] = {0};
        int gs = cmd_get(DS_PARAM_VISUALIZER_DATA, empty, 80,
                         vis_snapshot_a, 80);
        printf("    snapshot A (after warm-up, 440 Hz sine)\n"
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
    /* Engine is in the post-crossfade (-ENODATA) DISABLED state here.
     * With the output pre-ZEROED, a disabled block returns out == input
     * (passthrough) and leaves the input buffer clobbered. Test A then
     * pre-fills the output with garbage instead of zeroing it:
     *   out == in        => OVERWRITE
     *   out == prior + in => ACCUMULATE
     * (the zeroed case above is just ACCUMULATE's 0 + in identity). */
    {
        fill_sine(pcm_in, frames, rate, 20000.0, 440.0);
        measure("input ref (fresh sine)", pcm_in, frames);

        audio_buffer_t in  = { .frameCount = frames, .s16 = pcm_in };
        audio_buffer_t out = { .frameCount = frames, .s16 = pcm_out };
        memset(pcm_out, 0, frames * 4);
        int32_t pr = (*H)->process(H, &in, &out);
        char tag[80];
        snprintf(tag, sizeof tag, "disabled out, out pre-zeroed (process=%d)", pr);
        measure(tag, pcm_out, frames);                     /* ==input => #2 */
        measure("input after process()", pcm_in, frames);  /* <<input => #3 */

        /* Test A — fill the output with garbage and DON'T zero it.
         * garbage=8000 keeps garbage+peak (19999) inside int16 so the
         * peak/rms stay readable; the per-sample match below is decisive. */
        const int16_t garbage = 8000;
        fill_sine(pcm_in, frames, rate, 20000.0, 440.0);
        memcpy(in_ref, pcm_in, frames * 4);
        for (int i = 0; i < frames * 2; ++i) pcm_out[i] = garbage;
        measure("output prefilled w/ garbage", pcm_out, frames);
        in.s16 = pcm_in;  in.frameCount = frames;
        out.s16 = pcm_out; out.frameCount = frames;
        pr = (*H)->process(H, &in, &out);                  /* deliberately NOT zeroed */
        snprintf(tag, sizeof tag, "disabled out, prefill=%d (process=%d)",
                 garbage, pr);
        measure(tag, pcm_out, frames);
        int over = 0, accum = 0;
        for (int i = 0; i < frames * 2; ++i) {
            if (pcm_out[i] == in_ref[i]) over++;
            if (pcm_out[i] == (int16_t)(in_ref[i] + garbage)) accum++;
        }
        printf("    Test A: overwrite-match=%d/%d accumulate-match=%d/%d -> %s\n",
               over, frames * 2, accum, frames * 2,
               over  == frames * 2 ? "OVERWRITE (out = in; prior output discarded)" :
               accum == frames * 2 ? "ACCUMULATE (out = prior_output + in)" :
                                     "NEITHER — engine transforms/mixes");
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

    /* Test B — does the ENABLED process() also clobber its input, and is
     * the residue FIXED or PROGRESSIVE? Warm past the enable crossfade,
     * load one fresh block, then run successive blocks WITHOUT refilling
     * and watch the input: flat plateau => fixed in-place result;
     * monotonic decay => progressive mutation. */
    {
        process_blocks(pcm_in, pcm_out, frames, 35);   /* warm, streamed */
        fill_sine(pcm_in, frames, rate, 20000.0, 440.0);
        printf("    Test B — enabled input mutation (fresh sine, then 6 "
               "blocks, NO refill):\n");
        measure("  input pre-block (fresh)", pcm_in, frames);
        for (int b = 0; b < 6; ++b) {
            audio_buffer_t in  = { .frameCount = frames, .s16 = pcm_in };
            audio_buffer_t out = { .frameCount = frames, .s16 = pcm_out };
            memset(pcm_out, 0, frames * 4);
            int32_t pr = (*H)->process(H, &in, &out);
            char tg[56];
            if (b == 0) {
                snprintf(tg, sizeof tg, "  out block 0 (process=%d)", pr);
                measure(tg, pcm_out, frames);
            }
            snprintf(tg, sizeof tg, "  input after enabled block %d", b);
            measure(tg, pcm_in, frames);
        }
    }

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

    /* ── 7. Behavioral sweep: the clamped registry drives the DSP ── */
    printf("\n=== 7. BEHAVIORAL SWEEP — DSP reads the CLAMPED registry ===\n");
    int16_t on = 1, off = 0;

    /* (7a) WHICH store does the DSP read? Run FIRST, before any stateful
     * effect (leveler/maximizer) is exercised, so the path stays clean. A
     * linear GEQ band gain settles to a reproducible steady state; the two
     * control diffs (repro, return-to-0) must be ~0 for the test to mean
     * anything. Then poke ONLY the cache (registry frozen, verified via
     * ak_get): output unchanged => the DSP reads the clamped registry. */
    {
        int16_t g_on = 1, g_off = 0, flat = 0, boost = 160;
        set_param("dvle", 0, &off, 1);      /* leveler + maximizer OFF: clean */
        set_param("vmon", 0, &off, 1);
        set_param("geon", 0, &g_on, 1);     /* GEQ on, IEQ off */
        set_param("ieon", 0, &g_off, 1);
        const int band = 4;                  /* gebf[4] = 431 Hz */
        int gslot = settings_begin[find_param("gebg")] + band;
        int16_t *cache = (int16_t *)find_cache();
        int16_t *base = calloc(frames * 2, 2);
        int16_t *pre  = calloc(frames * 2, 2);
        #define GEQ_BLOCKS(n) do { for (int i = 0; i < (n); i++) {             \
            fill_sine(pcm_in, frames, rate, 6000.0, 431.0);                    \
            audio_buffer_t in = { .frameCount = frames, .s16 = pcm_in };       \
            audio_buffer_t out = { .frameCount = frames, .s16 = pcm_out };     \
            memset(pcm_out, 0, frames * 4); (*H)->process(H, &in, &out); }     \
        } while (0)

        set_param("gebg", band, &flat, 1);  GEQ_BLOCKS(60);    /* settle */
        memcpy(base, pcm_out, frames * 4);
        GEQ_BLOCKS(40);
        int d_repro = diff_count(base, pcm_out, frames * 2);    /* noise floor */
        set_param("gebg", band, &boost, 1); GEQ_BLOCKS(40);     /* SET: both stores */
        int d_set = diff_count(base, pcm_out, frames * 2);      /* the effect */
        set_param("gebg", band, &flat, 1);  GEQ_BLOCKS(40);     /* back to 0 */
        memcpy(pre, pcm_out, frames * 4);                       /* state just before poke */
        cache[gslot] = boost;                                   /* POKE cache only */
        int reg = ak_get_param("gebg", band);
        GEQ_BLOCKS(40);
        int d_poke = diff_count(pre, pcm_out, frames * 2);      /* poke's own effect */
        cache[gslot] = flat;
        /* poke is inert if its diff stays near the noise floor, far below the
         * SET effect (registry); it would rival the SET effect if read (cache). */
        printf("    GEQ band %d cache-poke (noise floor repro=%d/%d):\n"
               "      SET gebg=160 -> %d/%d changed (effect); POKE cache=160\n"
               "      (ak_get=%d, registry frozen) -> %d/%d -> %s\n",
               band, d_repro, frames * 2, d_set, frames * 2,
               reg, d_poke, frames * 2,
               d_set < 8 * (d_repro + 1)
                   ? "INVALID TEST — SET barely moved the output (d_set near noise floor)"
                   : d_poke * 8 < d_set
                       ? "DSP READS CLAMPED REGISTRY (cache poke inert)"
                       : "DSP reads cache");
        free(pre);
        set_param("geon", 0, &g_off, 1);
        free(base);
        #undef GEQ_BLOCKS
    }

    /* (7b) Behavioral sweeps — gross illustration that in-range values drive
     * the DSP and over-range writes collapse onto the clamp (dvla 10==200;
     * vmb 240==480). These run through the stateful leveler/maximizer, so
     * read peak/rms as trends, not exact figures (see #2/#9 for the precise
     * clamped values via ak_get). Enable the leveler so dvla has an effect. */
    set_param("dvle", 0, &on, 1);
    int16_t lkfs = -320;
    set_param("dvli", 0, &lkfs, 1);
    set_param("dvlo", 0, &lkfs, 1);
    process_blocks(pcm_in, pcm_out, frames, 30);

    int16_t dvla_sweep[] = {0, 5, 10, 200};
    printf("    dvla sweep (declared 0..10; 10 and 200 collapse = clamp):\n");
    for (size_t i = 0; i < sizeof dvla_sweep / sizeof dvla_sweep[0]; ++i) {
        int16_t v = dvla_sweep[i];
        set_param("dvla", 0, &v, 1);
        process_blocks(pcm_in, pcm_out, frames, 30);
        char tag[40]; snprintf(tag, sizeof tag, "dvla=%-5d", v);
        measure(tag, pcm_out, frames);
    }
    set_param("dvle", 0, &off, 1);

    int16_t vmon_on = 1;
    set_param("vmon", 0, &vmon_on, 1);
    int16_t vmb_sweep[] = {0, 120, 240, 480};
    printf("    vmb sweep (declared 0..240; 240 and 480 collapse = clamp at 192):\n");
    for (size_t i = 0; i < sizeof vmb_sweep / sizeof vmb_sweep[0]; ++i) {
        int16_t v = vmb_sweep[i];
        set_param("vmb", 0, &v, 1);
        process_blocks(pcm_in, pcm_out, frames, 30);
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

    /* The destructive 'begin + count > cache_total' SET is deferred to the
     * very end (it corrupts the heap by design), so the experiments below
     * still run on an intact heap. */

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

    /* ── 9. AK registry — the live engine state (ak_get/ak_get_bulk) ─ */
    printf("\n=== 9. AK REGISTRY (ak_get) — live engine state ===\n");
    {
        process_blocks(pcm_in, pcm_out, frames, 30);   /* warm the visualizer */

        /* (a) ak_get reproduces cmd 4 exactly — same source, the registry.
         * cmd 4 = vcbg‖vcbe (40 int16s), so check BOTH halves: vcbg vs the
         * gains (vis[0..19]) and vcbe vs the excitations (vis[20..39]). */
        uint8_t empty[80] = {0};
        int16_t vis[40] = {0};
        cmd_get(DS_PARAM_VISUALIZER_DATA, empty, 80, vis, 80);
        int mg = 0, me = 0;
        for (int e = 0; e < 20; e++) {
            if (ak_get_param("vcbg", e) == vis[e])      mg++;
            if (ak_get_param("vcbe", e) == vis[20 + e]) me++;
        }
        char fc[5]; ak_fourcc(ak_get_name(AK, ak_ref("vcbg")), fc);
        printf("    (a) ak_get vs cmd 4: gains %d/20, excitations %d/20 match  "
               "(ak_get_name(vcbg)=\"%s\")\n", mg, me, fc);

        /* (b) vnbg/vnbe have NO cmd 4 path but ARE readable here — and BOTH
         * mirror vcbg/vcbe (the native visualizer duplicates the current). */
        int mng = 0, mne = 0;
        for (int e = 0; e < 20; e++) {
            if (ak_get_param("vnbg", e) == ak_get_param("vcbg", e)) mng++;
            if (ak_get_param("vnbe", e) == ak_get_param("vcbe", e)) mne++;
        }
        printf("    (b) vnbg == vcbg: %d/20, vnbe == vcbe: %d/20  "
               "(both live but mirrors of the vcb* channel)\n", mng, mne);

        /* (c) engine's true ranges (ak_get_min/max) vs the Java G[] table. */
        printf("    (c) range audit (engine vs G[] table):\n");
        const char *audit[] = { "dvla", "vmb", "vol", "gebg", "arbl", NULL };
        for (int i = 0; audit[i]; i++) {
            int p = find_param(audit[i]);
            if (!ak_ref(audit[i])) { printf("        %-4s (not in AK)\n", audit[i]); continue; }
            int emin = ak_get_min(AK, ak_ref(audit[i]));
            int emax = ak_get_max(AK, ak_ref(audit[i]));
            printf("        %-4s engine[%d..%d]  G[]=[%d..%d]%s\n",
                   audit[i], emin, emax, G[p].lo, G[p].hi,
                   (emin == G[p].lo && emax == G[p].hi) ? "" : "   <- TABLE WRONG");
        }

        /* (d) runtime-update scan: which params does the DSP write across
         * blocks of a different tone? Snapshot the registry, process, diff.
         * Both snapshots are cache-flat (settings_begin[]), so cache_total
         * sizes them exactly. NOTE: a value-diff is blind to an idempotent
         * same-value rewrite, so this bounds what *changes*, not every slot
         * the DSP writes. */
        int *snapA = calloc(cache_total, sizeof(int));
        int *snapB = calloc(cache_total, sizeof(int));
        snapshot_registry(snapA);
        for (int i = 0; i < 40; i++) {                  /* a different shape (90 Hz) */
            fill_sine(pcm_in, frames, rate, 12000.0, 90.0);
            audio_buffer_t in = { .frameCount = frames, .s16 = pcm_in };
            audio_buffer_t out = { .frameCount = frames, .s16 = pcm_out };
            memset(pcm_out, 0, frames * 4); (*H)->process(H, &in, &out);
        }
        snapshot_registry(snapB);
        printf("    (d) registry slots that CHANGED across runtime:");
        int non_vis = 0;
        for (int i = 0; i < NPARAM; i++) {
            int d = 0;
            for (int e = 0; e < G[i].len; e++)
                if (snapA[settings_begin[i] + e] != snapB[settings_begin[i] + e]) d++;
            if (d) {
                printf(" %s", G[i].name);
                const char *nm = G[i].name;
                if (strcmp(nm, "vcbg") && strcmp(nm, "vcbe") &&
                    strcmp(nm, "vnbg") && strcmp(nm, "vnbe")) non_vis++;
            }
        }
        printf("\n        (%s)\n", non_vis == 0
               ? "only visualizer slots changed value; nothing else moved"
               : "WARNING: a non-visualizer slot changed — see the list above");
        free(snapA); free(snapB);
    }

    /* ── 10. Java param-set discrepancy — Java's 64 vs the engine's root ──
     * Set-diff the engine's real root leaves (ak_enum from root, leaves only)
     * against G[] (verbatim DsAkSettings) — surfaces the mismatch instead of
     * asserting it: phantoms (in G[] but not a root leaf → ref 0, dead; they're
     * node params, see `dump tree`) and omissions (real root leaves G[] leaves
     * out: scpe/test). The full authoritative tree is `ddp_probe <lib> dump tree`. */
    printf("\n=== 10. JAVA PARAM-SET DISCREPANCY ===\n");
    {
        /* The engine's real root leaves: direct children of root (ref 1) with
         * no children of their own. */
        char     lname[128][5];
        uint32_t lref[128];
        int      nl = 0;
        for (int i = 0; nl < 128; i++) {
            uint32_t r = ak_enum(AK, 1, i);
            if (!r) break;
            if (ak_enum(AK, r, 0)) continue;          /* a node, not a leaf */
            lref[nl] = r; ak_fourcc(ak_get_name(AK, r), lname[nl]); nl++;
        }
        printf("    in Java's list but NOT an engine root leaf (phantom -> ref 0, dead):\n");
        for (int i = 0; i < NPARAM; i++) {
            int leaf = 0;
            for (int j = 0; j < nl && !leaf; j++) leaf = !strcmp(G[i].name, lname[j]);
            if (!leaf)
                printf("      %-4s -> ref %u  (not a root leaf; see dump tree)\n",
                       G[i].name, ak_ref(G[i].name));
        }
        printf("    engine root leaves Java OMITS (real, settable if registered):\n");
        for (int j = 0; j < nl; j++) {
            if (find_param(lname[j]) >= 0) continue;  /* already in G[] */
            uint32_t r = ak_find ? ak_find(AK, 1, pack_fourcc(lname[j])) : lref[j];
            printf("      %-4s -> ref %u  [%d .. %d] frac=%d\n", lname[j], r,
                   ak_get_min(AK, r), ak_get_max(AK, r), ak_get_frac_bits(AK, r));
        }
        printf("    => correct host set = Java's 64 − {phantoms} + {omitted}\n");
    }

    /* ── 8b. begin-only bounds check (DELIBERATELY LAST — corrupts heap) ─
     * Does the engine check 'begin' only, or 'begin + count'? A count=20 SET
     * starting 5 slots before the cache end writes 15 slots past it. This
     * resolves whether v1's count=20 SET against a 1-slot tail is rejected or
     * silently corrupts adjacent memory. The straddling write trashes the
     * heap, so it runs last and we `_Exit` straight after — the normal
     * free/EffectRelease teardown would double-free/abort on the corrupted
     * heap and make `make run` exit non-zero in CI. */
    printf("\n=== 8b. begin+count bounds (runs last; heap-destructive) ===\n");
    {
        int16_t vals[20] = {0};
        int begin = cache_total - 5;
        int rr = set_flat(begin, vals, 20);
        printf("    SET flat=%d count=20 (begin+count=%d, cache=%d) -> reply=%d\n"
               "        (%s)\n",
               begin, begin + 20, cache_total, rr,
               rr == 0
                   ? "engine accepts — only 'begin' is bounds-checked; v1's\n"
                     "         count=20-against-1-slot SET corrupts adjacent slots"
                   : "engine rejects — 'begin + count <= cache_total' enforced");
    }

    /* 8b corrupted the heap by design; stdout/stderr are unbuffered (setbuf
     * NULL at startup) so everything is already flushed. Skip the free/
     * EffectRelease/dlclose teardown — it would abort on the trashed heap —
     * and exit clean. The OS reclaims the process memory. */
    _Exit(0);
}
