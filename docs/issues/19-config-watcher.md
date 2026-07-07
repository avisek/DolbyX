# Slice 19 — `config.toml` watcher: hand-edit → live reload

**Goal.** Editing `config.toml` by hand (any external writer) makes the
daemon re-resolve state and every connected UI catch up — without the
watcher fighting the daemon's own writes.

**Blocked by:** Slice 18.
**Mode:** AFK.

## What to build

(ADR-0007 — `docs/adr/0007-toml-overlay-persistence-with-file-watcher.md`)
`ddp-persistence/src/file_watcher.rs` — a `notify`-based watcher on
**`config.toml` only**. `defaults.toml` and `parameters.toml` stay
startup-only reads (an edit there takes a daemon restart — deliberate).

- On external change: debounce **500 ms** (matching the write-side
  debounce), re-parse, re-resolve the full cascade, broadcast a fresh
  `state` snapshot to every client (no originator to suppress — non-WS
  source). Flush resolved changes to live engine sessions like any other
  state mutation.
- **Self-write suppression**: the daemon records each mtime it flushed
  and ignores watcher events matching within a **1 s quiet window** —
  otherwise every debounced flush would echo back as a reload.
- Malformed hand-edit: keep running on last-good state, log a clear
  warning; recover on the next valid write (refuse-to-start applies only
  at startup).

## Behaviors to test

1. [ ] External edit (e.g. change `dvla` under `[profile.music]`) →
       ~500 ms later state re-resolves, snapshot broadcast, engine
       receives the new value.
2. [ ] Editing a shared-layer key (`[profile]`) re-resolves every
       profile.
3. [ ] The daemon's own debounced flush does not trigger a reload
       (mtime suppression).
4. [ ] Rapid successive edits collapse into one reload (debounce).
5. [ ] Malformed TOML mid-run: state unchanged, warning logged, next
       valid edit recovers.
6. [ ] Manual demo: edit the file in an editor, watch the UI catch up.

## Tracer bullet

Integration test: start daemon on a tempdir, append
`[profile.music]\ndvla = 7` to `config.toml` externally, await the
broadcast snapshot carrying `dvla = 7` and the Stub `set_params`.

**Mock policy.** Stub engine; real filesystem + real watcher (tempdir).

## References

- ADR-0007 (`docs/adr/0007-toml-overlay-persistence-with-file-watcher.md`)
- Slice 10 — cascade + write-side debounce this pairs with
