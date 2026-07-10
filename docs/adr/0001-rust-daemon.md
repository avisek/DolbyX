# Rust for the daemon

The v2 daemon is Rust, replacing v1's C: strict typing across the daemon's
concurrent threads (HTTP/WS, audio IPC, engine supervision), `tokio` async
I/O including Windows named pipes, `serde`/`toml` persistence, and a Cargo
workspace that scales as crates accrue. `#![forbid(unsafe_code)]` applies
everywhere except the engine FFI boundary, where every `unsafe` carries a
`// SAFETY:` comment. Cost: a full rewrite — accepted to shed v1's
shared-state foot-guns and per-stream subprocess duplication.
