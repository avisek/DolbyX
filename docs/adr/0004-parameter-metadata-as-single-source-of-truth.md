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

The committed **param twin**, `parameters.engine.toml`, is
probe-generated and never loaded; CI diffs the engine-fact fields (`name
length min max frac_bits default`) to block drift while the product
fields (`kind category access label description help`) stay free.

The one gate exemption: **by-ref slots** carry no def metadata — the API
reads back frac 0 and full-int16 bounds. For the four DSP-owned vis
arrays (`vnbg vnbe vcbg vcbe`) `parameters.toml` records the real coding
instead — the engine's own help pins "scaled by 16 ie. 16 = 1 dB", ddp/02
the in-contract output range `[-192, 576]` — and the gate skips exactly
`min max frac_bits` there (a companion test pins the corrected values).
The remaining by-ref slots (`vnbf`, build/license identity) stay
API-verbatim: nothing consumes their bounds.

`default` is the **intrinsic power-on value**: the fresh-`ak_open`
registry state, captured post-open (`make dump-defaults`). The lifecycle
probe (`make -C tools/ddp_probe lifecycle`) proves that state
deterministic, rate-independent, and bit-stable through the DEFINE
handshake, SET_CONFIG at any rate, and ENABLE — only the six DSP-owned
visualizer slots (`vnnb vnbf vnbg vnbe vcbg vcbe`) move later, filled by
the first process blocks (rate-derived grid; measurement slots hold junk
until `ven=1`). A later capture would gain nothing and cost determinism.
Consequently `default` may legitimately sit outside `[min, max]`: bounds
govern writes (`ak_set` clamps), not storage — the engine itself boots
the `gebf`/`iebf`/`aobf`/`arbf`/`vcbf` zero-tails below min and `vnnb=0`
in `[1..20]`, and no lifecycle stage heals them. The parser deliberately
skips a default-within-bounds check.

Master-control membership is deliberately *not* metadata — it's a curated
UI overlay; those params also appear in the Advanced panel under their
feature categories, and their rendering facts come from this table by
4-CC lookup.
