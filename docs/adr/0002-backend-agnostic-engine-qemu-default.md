# Backend-agnostic engine, QEMU subprocess as v2.0 default

The daemon talks to the engine through a narrow `trait Engine` (eight
methods: `create_session`, `destroy_session`, `set_enabled`, `set_param`,
`set_params`, `get_visualizer_data`, `process`, `version`). There is
intentionally no `get_param` — the underlying engine has no cmd 3 GET, so
any read would be synthesized from the daemon's own state mirror.
`set_param` maps to the engine's single-write cmd 3; `set_params` maps to
the bulk cmd 2 (`DS_PARAM_ALL_VALUES`), used for profile and EQ-preset
switches so the engine applies the whole change on one audio block.
v2.0 ships one implementation: `QemuBackend`, which runs a single shared
`qemu-arm-static` subprocess holding `libdseffect.so` and multiplexing N
sessions internally, eliminating v1's per-stream subprocess startup and
memory duplication. A `create_session` at any rate other than the engine's
default 44100 Hz (e.g. a 32 or 48 kHz host) is handled inside the backend
via `libdseffect.so`'s `Ds1ap::New` hot-swap, keeping the trait surface
rate-agnostic. Future backends (`UnicornBackend` for in-process JIT,
`StaticBinaryBackend` for ARM→x86_64 translation) slot in behind the
same trait without touching daemon code. The trade-off is a WSL2
dependency on Windows for v2.0; v2.1 (Unicorn) removes it.
