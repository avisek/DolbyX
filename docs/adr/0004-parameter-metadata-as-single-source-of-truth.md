# Parameter metadata as single source of truth

The 53 AK parameters that `libdseffect.so` surfaces with a public read or
write path are declared once in a static metadata table
(`crates/ddp-state/parameters.toml` → codegen'd `parameters.rs`).
Everything else — wire protocol, engine init payload, persistence
serialization, UI widget generation, range validation — derives from
this table. Parameters carry a three-bucket settability classification
(`Settable` / `ReadOnly` / `Experimental`) reflecting DSP semantics +
UI presentation, not engine-level acceptance: empirical evidence from
[`tools/ddp_probe/`](../../tools/ddp_probe/README.md) shows the engine
accepts cmd 3 SET against any declared parameter regardless of Java's
`isParamSettable` whitelist. The remaining 11 slots (7 engine-internal
build-version / license slots `bver`, `bndl`, `ver`, `lcmf`, `lcvd`,
`lcsz`, `lcpt`, plus 4 native-visualizer slots `vnnb`, `vnbf`, `vnbg`,
`vnbe`) are omitted because they have no public read path; the engine
version string is surfaced via cmd 6 → bootstrap `engine.version`
instead. Adding a new parameter is a one-line edit; the UI
auto-discovers it on next page load.
