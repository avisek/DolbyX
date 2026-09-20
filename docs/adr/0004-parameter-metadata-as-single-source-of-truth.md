# Parameter metadata as single source of truth

All 64 root-leaf AK parameters are declared once in `parameters.toml` — a
runtime data file beside the daemon binary, loaded at startup,
hand-editable. Wire validation, engine init, persistence, UI widget
generation, ranges, and display scaling all derive from this table. It is
seeded from the engine's own tree (`ddp_probe` dumps), not transcribed
from Java, whose list registers two phantom names and omits two real
leaves
([ddp/02](../ddp/02-ak-parameters.md#javas-list-vs-the-engines-root-leaves)).

Settability is a four-bucket classification — Settable, Experimental,
ReadOnly-Dynamic, ReadOnly-Static — reflecting DSP semantics + UI
presentation, not engine acceptance: empirically the engine accepts a SET
against any declared param regardless of Java's whitelist
([`tools/ddp_probe/`](../../tools/ddp_probe/README.md)). Nothing is
dropped; even the build/license slots are plain ReadOnly-Static cards.

The table is **curated and validation-clean**: every `default` slot lies
in `[min, max]`, parser-enforced. Engine truth lives in the committed
**param twin**, `parameters.engine.toml` — probe-generated, never loaded.
CI checks the table's structure against it — names 1:1, `length` equal,
every range within the **engine envelope** (the twin's `[min, max]`) —
and leaves the values to curation. The deliberate divergences:

- **Inactive band slots** (`iebf gebf aobf arbf` tails, all of `vcbf`)
  clamp the engine's out-of-bounds power-on zeros to min — behaviorally
  inert: the engine ignores inactive slots and clamps writes.
- **`vnnb`** curates 20 — the rate-derived native-grid count at
  44.1/48 kHz — for the power-on 0 outside `[1..20]`.
- **The by-ref vis arrays** (`vnbg vnbe vcbg vcbe`) record the real dB
  coding the API doesn't report (by-ref slots read back frac 0 +
  full-int16 bounds): the engine's own help pins "scaled by 16 ie.
  16 = 1 dB", ddp/02 the output range `[-192, 576]`. The remaining
  by-ref slots (`vnbf`, build/license identity) stay API-verbatim —
  nothing consumes their bounds.

**Power-on defaults live in the twin**: the fresh-`ak_open` registry
state (`make dump-defaults`) — deterministic, rate-independent, stable
until the first process blocks fill the six DSP-owned visualizer slots
([lifecycle probe](../../tools/ddp_probe/README.md)). The engine
legitimately boots values outside its own write bounds (bounds clamp
writes, not storage); the table corrects exactly those slots — startup
readouts and the cascade base need usable in-bounds values — and
acceptance tests pin each correction
(`crates/ddp-daemon/tests/parameters.rs`).

Master-control membership is deliberately *not* metadata — it's a curated
UI overlay; those params also appear in the Advanced panel under their
feature categories, and their rendering facts come from this table by
4-CC lookup.

## Addendum (2026-09-20) — category table

Display composition joins the single source of truth as a `[[category]]`
table — the *only* place it lives:

```toml
[[category]]
name = "dialog_enhancer"          # closed ParamCategory id
label = "Dialog Enhancer"
params = ["deon", "dea", "ded"]   # card order
```

Table order is section order; `params` order is card order. The per-param
`category` field is gone — `ParameterDef.category` is derived from
membership, and the parser refuses to start unless every root leaf sits in
exactly one category, every category is non-empty, and every name resolves
(unknown 4-CC or category ⇒ error; `ParamCategory` stays a closed enum,
with `build_license` split into `build` and `license`).

`[[param]]` order stays pinned to the param twin's order so the two files
diff line-for-line — display order never reorders it. `label` is a short,
category-relative name ("Enable", "Amount") because the UI always shows the
category beside it; `description` keeps the engine's full phrasing.

Consequence for the UI: no per-param special casing — presentation derives
from kind, access, and category alone. Mechanical prefix rules (`*nb`
gating a group's live band count, `aobg`'s `1 + aonb` channel stride) are
rules, not cases.
