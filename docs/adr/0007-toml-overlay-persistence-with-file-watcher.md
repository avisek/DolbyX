# TOML overlay persistence with file watcher

Persistent state is two TOML files: `defaults.toml` beside the daemon
binary (factory profiles and EQ presets) and `config.toml` in the
platform data dir (the user's deltas on top). Resolution is a five-layer
cascade — `ParameterDef.default → defaults.toml shared → defaults.toml
item → config.toml shared → config.toml item` — and each file stores
only divergences from what resolves beneath it, so a fresh install
writes an **empty** `config.toml` and user diffs stay small and
inspectable. The shared layers are a hand-edit affordance the daemon
never writes. This echoes the original DDP's `ds1-default.xml` +
`ds1-current.xml` overlay; the metadata-default base and the shared
layers are v2 refinements (the original repeated the factory defaults in
full in every profile).

DolbyX is system-level — one install serves all users; the daemon runs
as a system service — so both paths (and the plugin socket) are
machine-wide.

A `notify` watcher subscribes to `config.toml` **only**, so a hand-edit
shows up in the UI live. `defaults.toml` and `parameters.toml`
([ADR-0004](0004-parameter-metadata-as-single-source-of-truth.md)) load
once at startup and are never watched; malformed → the daemon refuses to
start — fail loudly rather than run on stale metadata.
