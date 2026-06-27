# Parameter metadata as single source of truth

The 58 AK parameters that `libdseffect.so` surfaces with a public read or
write path are declared once in a static metadata table
(`crates/ddp-state/parameters.toml` → codegen'd `parameters.rs`), seeded
from the engine tree (`ddp_probe dump`), not transcribed from Java — so it
excludes Java's two phantom names (`mxou`, `lcsz`, which resolve to ref 0)
and includes the two real root leaves Java omits (`scpe`, `test`); see
[docs/ddp/02](../ddp/02-ak-parameters.md#javas-list-vs-the-engines-root-leaves).
Everything else — wire protocol, engine init payload, persistence
serialization, UI widget generation, range validation — derives from
this table. Parameters carry a three-bucket settability classification
(`Settable` / `ReadOnly` / `Experimental`) reflecting DSP semantics +
UI presentation, not engine-level acceptance: empirical evidence from
[`tools/ddp_probe/`](../../tools/ddp_probe/README.md) shows the engine
accepts cmd 3 SET against any declared parameter regardless of Java's
`isParamSettable` whitelist. The remaining 6 slots — engine-internal
build-version / license (`bver`, `bndl`, `ver`, `lcmf`, `lcvd`, `lcpt`) —
are omitted because they carry nothing the host needs; the engine version
string is surfaced via cmd 6 → bootstrap `engine.version` instead. (The
native-visualizer family `vnnb`/`vnbf`/`vnbg`/`vnbe` is **kept** as ReadOnly:
it's the engine's ground-truth filterbank output, which the custom
`vcbg`/`vcbe` channel resamples onto a host-set grid — `vc*` mirrors `vn*`
only until the custom bands are reconfigured.) Adding a new parameter is a
one-line edit; the UI auto-discovers it on next page load.
