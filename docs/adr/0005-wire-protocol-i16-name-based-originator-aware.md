# Wire protocol: name-based, originator-aware, i16 1/16-dB throughout

State snapshots, param writes, and the binary engine protocol all carry
the engine's native `int16` 1/16-dB values; only the UI converts to
float dB at display/input boundaries — one unit everywhere, no lossy
round-trips. Params travel by 4-CC name, never positional index, so
persistence and clients survive metadata reordering. The param surface
is batch-only with one payload shape — `params: { "<4-CC>": [i16, …] }`
— shared by `edit_profile` / `edit_eq_preset` / `vis`; a single-control
edit is a 1-entry map. Every command carries a client-generated
`request_id`, echoed in its `ack`/`error` — replies on a multiplexed
WebSocket aren't positionally paired.

**Originator-aware broadcast.** While handling a command from connection
*C*, the daemon broadcasts the resulting state to every connection
except *C* (an internal `ConnId`, never on the wire). Not
echo-avoidance: it protects *C*'s in-flight edits (a live GEQ/slider
drag) from a round-trip-lagged snapshot; *C*'s `ack` is its
authoritative confirmation. `vis` broadcasts unconditionally.

**Asymmetric validation.** The daemon owns all value validation up front
and rejects with `INVALID_REQUEST` (its only rejection code); engine
status errors surface as `ENGINE_REJECTED`. The engine never rejects an
out-of-range value — it **silently clamps** to its own registry bounds,
which can differ from published tables
([`tools/ddp_probe/`](../../tools/ddp_probe/README.md) §7) — so the
daemon validates rather than relying on the hidden clamp.
