# Rust for the daemon

The v2 daemon is written in Rust, replacing the v1 C implementation. Rust
gives us strict typing across the daemon's concurrent threads (HTTP,
WebSocket, audio I/O, visualizer pump, engine subprocess management),
`tokio`-based cross-platform async I/O including Windows named pipes,
`axum` + `tokio-tungstenite` for HTTP and WebSocket with minimal glue,
`serde` + `toml` for persistence, and a Cargo workspace that scales as
crates accrue. `#![forbid(unsafe_code)]` applies everywhere except the
engine FFI boundary, where every invariant carries a `// SAFETY:` comment.
The cost is a full rewrite versus continuing in C; the payoff is the
absence of v1's shared-state foot-guns and per-stream subprocess
duplication.
