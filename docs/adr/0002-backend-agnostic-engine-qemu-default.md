# Backend-agnostic engine, QEMU subprocess as v2.0 default

The daemon talks to the engine through a narrow `trait Engine` (six
methods: `create_session`, `destroy_session`, `set_enabled`,
`set_params`, `get_params`, `process`). The parameter surface is
batch-only — a single-control edit is a 1-entry batch — and is served
by the engine's AK accessors directly, not the cmd protocol — the
AK-direct binding ([ADR-0010](0010-ak-direct-params-cmd-lifecycle.md)) —
so `get_params` is a real read of the live registry via `ak_get` /
`ak_get_bulk`, and one `set_params` lands a profile or EQ-preset
switch on one audio block. The visualizer needs
no read call at all: every `process` reply carries the four
ReadOnly-Dynamic arrays as its `VisFrame` (the vis tail, ADR-0010).
v2.0 ships one implementation: `QemuBackend`, which runs a single shared
`qemu-arm-static` subprocess holding `libdseffect.so` and multiplexing N
sessions internally, eliminating v1's per-stream subprocess startup and
memory duplication. A `create_session` at any rate other than the engine's
default 44100 Hz (e.g. a 32 or 48 kHz host) is handled inside the backend
via `EFFECT_CMD_SET_CONFIG` (cmd 1), keeping the trait surface
rate-agnostic. Future backends (`UnicornBackend` for in-process JIT,
`StaticBinaryBackend` for ARM→x86_64 translation) slot in behind the
same trait without touching daemon code. The trade-off is a WSL2
dependency on Windows for v2.0; v2.1 (Unicorn) removes it.
