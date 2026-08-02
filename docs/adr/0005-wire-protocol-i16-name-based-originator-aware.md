# Wire protocol: name-based, originator-aware, i16 1/16-dB throughout

State snapshots, param writes, and the binary engine protocol all carry
the engine's native `int16` 1/16-dB values; only the UI converts to
float dB at display/input boundaries — one unit everywhere, no lossy
round-trips. Params travel by 4-CC name, never positional index, so
persistence and clients survive metadata reordering. The param surface
is batch-only with one payload shape — `params: { "<4-CC>": [i16, …] }`
— shared by `add_*` / `edit_*` / `vis`; a single-control edit is a
1-entry map. Every command carries a client-generated `request_id`,
echoed in exactly one reply — `ack` (carrying the minted `id` on
`add_*`), `error`, or, for `get_state`, the `state` event itself —
replies on a multiplexed WebSocket aren't positionally paired.
Broadcast `state` / `vis` events carry no `request_id`.

**Content grammar.** Items are config rows; commands are row
operations, uniform across profiles and EQ presets: `add_*` creates an
item from its **content** (`name` + params + EQ selection), never
from a source reference — "clone" is a UI gesture, the client copies
resolved values it already holds, so capturing the None state needs no
special wire support and add validation is `edit_*`'s verbatim.
`edit_*` is the one sparse patch verb (a rename is `edit { id, name }`,
an EQ selection is `edit_profile { id, selected_eq_preset }` — there
are no `rename_*` / `set_eq_preset` commands). `reset_*
{ id, only?: [content-key…] }` is the un-edit — dropping divergences so
the cascade beneath resolves ([ADR-0007](0007-toml-overlay-persistence-with-file-watcher.md)).
Each item's snapshot carries its `baseline` — what resolves beneath its
config row, mirroring the item's content shape — so divergence
(resolved ≠ baseline, per content key) is **client-derived**: exactly
the keys a whole-item reset would clear. The snapshot ships inputs,
never precomputed affordances — originator suppression (below) would
starve them on the very tab that's editing. Commands are atomic —
reject all or apply all.

**Originator-aware broadcast.** While handling a command from connection
*C*, the daemon broadcasts the resulting state to every connection
except *C* (an internal `ConnId`, never on the wire). Not
echo-avoidance: it protects *C*'s in-flight edits (a live GEQ/slider
drag) from a round-trip-lagged snapshot; *C*'s `ack` is its
authoritative confirmation. `vis` broadcasts unconditionally.

**Asymmetric validation.** The daemon owns all value validation up front
and rejects with `INVALID_REQUEST` (its only validation code); engine
status errors surface as `ENGINE_REJECTED`; the one operational failure
with its own code is `LAN_BIND_FAILED`
([ADR-0012](0012-lan-access-opt-in-app-owned-gate-no-auth.md)). The
engine never rejects an
out-of-range value — it **silently clamps** to its own registry bounds,
which can differ from published tables
([`tools/ddp_probe/`](../../tools/ddp_probe/README.md) §7) — so the
daemon validates rather than relying on the hidden clamp.
