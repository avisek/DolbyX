//! The engine shim: ARMv7 binary that dlopens `libdseffect.so`, routes
//! sessions, and serves the daemon↔engine protocol over stdin/stdout —
//! the only code touching the engine's exported symbols.
//!
//! Skeleton — protocol + session lifecycle land in Slice 06
//! ([#14](https://github.com/avisek/DolbyX/issues/14)). This is the one
//! crate that will host the engine FFI boundary; `forbid(unsafe_code)`
//! relaxes to targeted `unsafe` + `// SAFETY:` there (ADR-0001).

#![forbid(unsafe_code)]

fn main() {}
