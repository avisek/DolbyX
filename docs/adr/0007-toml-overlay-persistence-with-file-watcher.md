# TOML overlay persistence with file watcher

Persistent state is two TOML files: `defaults.toml` beside the daemon
binary (factory profiles and EQ presets) and `config.toml` in the
platform data dir (the user's deltas on top). Resolution is a five-layer
cascade — `ParameterDef.default → defaults.toml shared → defaults.toml
item → config.toml shared → config.toml item` — and each file stores
only divergences from what resolves beneath it, so a fresh install
writes an **empty** `config.toml` and user diffs stay small and
inspectable. Divergence-only is a **write law**, not a habit: a stated
value — param or EQ selection alike — equal to what resolves beneath is
dropped, not stored, enforced at every write-back; a row key exists iff
the item diverges. The shared layers are a hand-edit affordance the
daemon never writes. This echoes the original DDP's `ds1-default.xml` +
`ds1-current.xml` overlay; the metadata-default base and the shared
layers are v2 refinements (the original repeated the factory defaults in
full in every profile).

A profile's `selected_eq_preset` is itself a cascaded key, item rows
only (the shared tables stay params-only): a `defaults.toml` item row
may ship a factory EQ selection — it must name a `defaults.toml` preset —
and the `config.toml` row shadows it. Key absent = inherit; the
reserved id `"none"` encodes a **diverging** no-preset — written only
when an EQ selection resolves beneath, per the write law (TOML has no null;
customs mint `user_<hash>`, no row may claim id `none`, and
`defaults.toml` may not define an item named `none`, so it never
collides). On the wire a no-preset override is JSON `null`.

Reset is the cascade's undo, valid on **every** item: it drops the
id's `config.toml` divergences — whole-row or scoped to named content
keys — so the layers beneath resolve. A factory item falls to its
bundled defaults; a custom item, having no `defaults.toml` row, falls
to the shared layers — *not* its birth clone. `name` is never reset
(customs would lose their identity's label).

DolbyX is system-level — one install serves all users; the daemon runs
as a system service — so both paths (and the plugin socket) are
machine-wide.

A `notify` watcher subscribes to `config.toml` **only**, so a hand-edit
shows up in the UI live. `defaults.toml` and `parameters.toml`
([ADR-0004](0004-parameter-metadata-as-single-source-of-truth.md)) load
once at startup and are never watched; malformed → the daemon refuses to
start — fail loudly rather than run on stale metadata.
