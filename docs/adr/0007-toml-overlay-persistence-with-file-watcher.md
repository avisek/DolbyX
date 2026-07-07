# TOML overlay persistence with file watcher

Persistent state lives in two TOML files: `defaults.toml` (next to the
daemon binary — factory profiles and EQ presets) and `config.toml`
(platform data dir — the user's deltas on top). DolbyX is
system-level — one install serves all users; the daemon runs as a
system service (systemd unit / Windows service) — so both paths are
machine-wide, as is the plugin socket (`/run/dolbyx/dolbyx.sock`).
Each file has two namespaces parsed by one rule: a sub-table
(`[profile.<id>]` / `[eq_preset.<id>]`) holds one item's params; any
other key in the `[profile]` / `[eq_preset]` table is shared by
**every** item. The root level is exactly `power` + `selected_profile` —
each written to `config.toml` only when it diverges from factory.
Resolution is a five-layer cascade — `ParameterDef.default →
defaults.toml shared → defaults.toml item → config.toml shared →
config.toml item` — and a param absent everywhere resolves to its
`ParameterDef.default`. Write-back is always per-item and sparse by base:
`defaults.toml` stores deltas over `ParameterDef.default`, while
`config.toml` stores only what diverges from whatever resolves beneath it
— so a fresh install (nothing diverged) writes an **empty** `config.toml`.
The shared layers are a hand-edit affordance the daemon never writes.
`is_factory` is derived at load time from `defaults.toml` presence, not
stored on disk.

A `notify`-based watcher subscribes to `config.toml` **only**;
`defaults.toml` and `parameters.toml` (the metadata table,
[ADR-0004](0004-parameter-metadata-as-single-source-of-truth.md)) load
once at startup and are never watched — a malformed `parameters.toml`
makes the daemon refuse to start. On a `config.toml` change the daemon
debounces 500 ms (matching the write-side debounce), re-overlays, and
broadcasts a fresh state snapshot to every connected client,
suppressing watcher events that match its own writes within a 1 s
quiet window.

The overlay echoes the original DDP's `ds1-default.xml` +
`ds1-current.xml`; the `ParameterDef.default` base and the shared
layers are v2 refinements (the original repeated the factory
defaults in full in every profile). User diffs stay small and
inspectable, and a hand-edit to `config.toml` shows up in the UI live.
