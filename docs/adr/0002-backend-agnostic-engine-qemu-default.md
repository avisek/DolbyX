# Backend-agnostic engine, QEMU subprocess as v2.0 default

The daemon reaches the engine only through the narrow `trait Engine`
(session create/destroy, enable, batch-only param set/get, process — the
param surface is AK-direct,
[ADR-0010](0010-ak-direct-params-cmd-lifecycle.md)). v2.0 ships one
implementation, `QemuBackend`: a single shared `qemu-arm-static`
subprocess holds `libdseffect.so` and multiplexes all sessions,
eliminating v1's per-stream subprocess startup and memory duplication.
Future backends (`UnicornBackend` in-process JIT, `StaticBinaryBackend`
ARM→x86_64 translation) slot in behind the same trait without touching
daemon code. Trade-off: v2.0 needs WSL2 on Windows; v2.1 (Unicorn)
removes it.
