# Wire protocol: name-based, originator-aware, i16 1/16-dB throughout

All state snapshots, `set_params` commands, and the binary engine
protocol carry raw `int16` 1/16-dB values end-to-end. Only the
UI converts `int16 ↔ float dB` at display and input boundaries. AK
parameters are identified on the wire and in persistence by their 4-CC
name, not by positional index, so configs survive reordering of the
metadata table. The param surface is batch-only: `set_params`,
`edit_eq_preset`, and the `vis` event share one payload shape —
`params: { "<4-CC>": [i16, …] }` — and a single-control edit is a
1-entry map. Every command carries a client-generated `request_id`,
echoed in its `ack` / `error`, correlating replies over the
multiplexed WebSocket. The daemon assigns each WebSocket connection a
serial originator id at handshake and broadcasts state changes to all
clients **except** the originator, preventing echo loops in multi-tab
scenarios. `vis` events (keyed `vnbg` / `vnbe` / `vcbg` / `vcbe`)
broadcast unconditionally. Validation is asymmetric by design: the
daemon owns range validation up front and rejects with
`INVALID_REQUEST` — its only rejection code — while engine status
errors surface as `ENGINE_REJECTED`. The engine *does* silently clamp
an out-of-range write — but only in its AK registry, to its
own bounds (which differ from the published table for some params), while
the raw value lingers in the settings cache; see
[`tools/ddp_probe/`](../../tools/ddp_probe/README.md) section 7 and
[ddp/03 → Engine validation behavior](../ddp/03-binary-protocol.md#engine-validation-behavior).
Host-side validation keeps behaviour predictable instead of relying on that
hidden clamp.
