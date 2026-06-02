# Backend-agnostic engine, QEMU subprocess as v2.0 default

The daemon talks to the engine through a narrow `trait Engine` (seven
methods: `create_session`, `destroy_session`, `set_enabled`, `set_param`,
`get_visualizer_data`, `process`, `version`). There is intentionally no
`get_param` — the underlying engine has no cmd 3 GET, so any read would
be synthesized from the daemon's own state mirror. v2.0 ships one
implementation: `QemuBackend`, which runs a single shared
`qemu-arm-static` subprocess holding `libdseffect.so` and multiplexing N
sessions internally, eliminating v1's per-stream subprocess startup and
memory duplication. Future backends (`UnicornBackend` for in-process JIT,
`StaticBinaryBackend` for ARM→x86_64 translation) slot in behind the
same trait without touching daemon code. The trade-off is a WSL2
dependency on Windows for v2.0; v2.1 (Unicorn) removes it.
