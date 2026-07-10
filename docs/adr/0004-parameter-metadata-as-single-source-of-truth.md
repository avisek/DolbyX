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

Master-control membership is deliberately *not* metadata — it's a curated
UI overlay; those params also appear in the Advanced panel under their
feature categories, and their rendering facts come from this table by
4-CC lookup.
