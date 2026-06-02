# TOML overlay persistence with file watcher

Persistent state lives in two TOML files: `defaults.toml` (next to the
daemon binary, holds factory profiles and EQ presets with their full
default values) and `config.toml` (platform data dir, stores only user
deltas). `is_factory` is derived at load time from `defaults.toml`
presence, not stored on disk. `notify`-based watchers subscribe to
external edits on both files; on change, the daemon debounces 500 ms
(matching the write-side debounce), re-overlays the two files, and
broadcasts a fresh state snapshot to every connected client. The daemon
suppresses watcher events that match its own writes within a 1 s quiet
window. This matches the original DDP's overlay model
(`ds1-default.xml` + `ds1-current.xml`), keeps user diffs small and
inspectable, and lets users hand-edit either file and watch the UI catch
up.
