# Slice 18 — Custom profiles & EQ presets (full CRUD)

**Goal.** Users add, rename, edit, delete, and reset custom profiles and
custom EQ presets; deletes fall referencing items back to safe defaults;
everything persists.

**Blocked by:** Slice 15.
**Mode:** AFK.

## What to build

- `WsCommands(add_profile, rename_profile, remove_profile, add_eq_preset,
  rename_eq_preset, remove_eq_preset)` — epic wire protocol has the
  shapes. `add_* { from, name }` clones the source item's overrides under
  a freshly minted server-side id (`user_<hash>`, e.g. `user_a3f1`),
  returned on the `ack` (`id` field) so the originator applies locally
  without waiting for a snapshot.
- Invariants (in `State`, validation → `INVALID_REQUEST`):
  - Factory items (id present in `defaults.toml`) cannot be deleted or
    renamed; they can be reset. `is_factory` stays derived, never stored.
  - Custom items rename by `name`, never by `id` (persistence keys on
    id).
  - Deleting a custom EQ preset selected by N profiles → all N fall back
    to `None` (their own EQ params — no Off preset).
  - Deleting the currently selected custom profile → selection falls back
    to `music`.
- `reset_*` stays **factory-only** (reset = remove the id's `config.toml`
  overrides, falling back to `defaults.toml`; a custom item has no layer
  beneath its overrides — resetting it would mean deleting it). Reject
  reset on custom ids with `INVALID_REQUEST`; the UI shows Reset only on
  factory items.
- Custom profiles have **no category** — just the user's name in the list
  (plan Decision 8: the original's category drove only an icon; dropped).
- Persistence: custom items live entirely in `config.toml`
  (`[profile.user_a3f1]`, `[eq_preset.user_91c2]` — id is the table key,
  `name` a key inside).
- UI affordances: add (clone current), rename, delete, reset on
  ProfileTabs + EqPresetPicker.

## Behaviors to test

1. [ ] `is_factory(id)` derived from `defaults.toml` presence; nothing
       stored on disk.
2. [ ] `add_profile { from: "music", name: "Late Night" }` clones Music's
       overrides under a fresh `user_<hash>` id, returned on the `ack`.
3. [ ] Rename updates `name`, id stable, persistence keys unchanged.
4. [ ] Factory delete/rename → `INVALID_REQUEST`.
5. [ ] Deleting a preset selected by N profiles → all fall to `None`;
       flush-iff-live pushes the active profile's own EQ params.
6. [ ] Deleting the selected profile → fallback to `music`, engine gets
       Music's resolved set.
7. [ ] `reset_profile` / `reset_eq_preset` clears `config.toml` overrides
       for factory ids; `defaults.toml` untouched.
8. [ ] All CRUD survives restart.
9. [ ] qemu replay green.

## Tracer bullet

Add a custom profile from Music, rename it, restart the daemon, assert it
survived with the new name and same overrides.

**Mock policy.** Stub; behavior 9 real.

## References

- Epic: wire protocol (CRUD commands, ack-minted ids), data model
  (factory rules)
- ADR-0003 (`docs/adr/0003-global-eq-presets-and-geq-per-preset.md`),
  ADR-0007 (`docs/adr/0007-toml-overlay-persistence-with-file-watcher.md`)
