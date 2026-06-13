# TOML overlay persistence with file watcher

Persistent state lives in two TOML files: `defaults.toml` (next to the
daemon binary, holds each factory profile / EQ preset's deltas over the
codegen'd `ParameterDef.default` base) and `config.toml` (platform data
dir, the user's deltas on top). Resolution is `ParameterDef.default →
defaults.toml → config.toml`; a param absent from both files resolves to
its `ParameterDef.default`. `is_factory` is derived at load time from
`defaults.toml` presence, not stored on disk. `notify`-based watchers subscribe to
external edits on both files; on change, the daemon debounces 500 ms
(matching the write-side debounce), re-overlays the two files, and
broadcasts a fresh state snapshot to every connected client. The daemon
suppresses watcher events that match its own writes within a 1 s quiet
window. The two-file overlay echoes the original DDP's `ds1-default.xml` +
`ds1-current.xml`; the `ParameterDef.default` base is a v2 refinement
(the original repeated the factory defaults in full in every profile).
It keeps user diffs small and inspectable, and lets users hand-edit
either file and watch the UI catch up.
