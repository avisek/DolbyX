# Parameter metadata as single source of truth

All 64 root-leaf AK parameters `libdseffect.so` exposes are declared
once in `parameters.toml` — a runtime data file shipped next to the
daemon binary, loaded at startup, hand-editable — seeded from the engine
tree (`ddp_probe dump-tree` / `dump-docs` / `dump-defaults`), not
transcribed from Java: it excludes Java's two phantom names (`mxou`,
`lcsz`, which resolve to ref 0) and includes the leaves Java's list
omits (`scpe`, `test`); see
[docs/ddp/02](../ddp/02-ak-parameters.md#javas-list-vs-the-engines-root-leaves).
Everything else — wire protocol, engine init payload, persistence
serialization, UI widget generation, range validation, display scaling
(uniform `frac_bits`: display = raw / 2^`frac_bits`) — derives from
this table.

Settability is a four-bucket classification reflecting DSP semantics + UI
presentation, not engine-level acceptance (empirically the engine
accepts cmd 3 SET against any declared parameter regardless of Java's
`isParamSettable` whitelist; [`tools/ddp_probe/`](../../tools/ddp_probe/README.md)):
**Settable** (42 — Java's whitelist), **Experimental** (10 — `preg pstg
endp ocf ven vol vcnb vcbf scpe test`), **ReadOnly-Dynamic** (4 — `vnbg
vnbe vcbg vcbe`, riding every `vis` event), **ReadOnly-Static** (8 —
`vnnb vnbf` + `bver bndl ver lcmf lcvd lcpt`, read once after
`SET_CONFIG`; `vnnb`/`vnbf` are rate-derived, hence the re-read on
reconfig). Nothing is dropped — `ak_get_bulk`
([ADR-0010](0010-ak-direct-params-cmd-lifecycle.md)) reads any leaf, so
the build/license slots are plain ReadOnly-Static cards and `ver` is
the engine-version readout.

A committed twin, `parameters.engine.toml`, is probe-generated,
reference-only, never loaded; a CI diff gate blocks drift on the
engine-fact fields (`name length min max frac_bits default`) while the
product fields (`kind category access label description help`) stay
free. Adding a parameter is an edit to `parameters.toml` plus a daemon
restart; the UI auto-discovers it via bootstrap.

Master-control membership is deliberately *not* metadata — it's
a curated UI overlay (`MasterControls.tsx`); those params still appear in the
Advanced panel under their feature categories, and their rendering facts come
from this table by 4-CC lookup.
