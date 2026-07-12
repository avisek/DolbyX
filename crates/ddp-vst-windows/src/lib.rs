//! Thin VST2 plugin for Windows hosts (EqualizerAPO): audio over the
//! `\\.\pipe\DolbyX` named pipe to the daemon (issue #21).
//!
//! No DSP, no state — all control lives in the Web UI. The plugin
//! converts float32 ↔ int16 once at the host boundary, ferries blocks
//! through the daemon's engine, and passes through dry (with periodic
//! reconnects) whenever the daemon is away — audio never stops.

#![deny(unsafe_code)]

mod client;
#[cfg_attr(
    windows,
    expect(unsafe_code, reason = "the ShellExecuteW / window FFI (issue #21)")
)]
mod editor;
mod effect;
#[expect(unsafe_code, reason = "the VST2 FFI boundary — host raw pointers")]
mod entry;
pub mod pcm;
mod transport;
pub mod vst2;

pub use client::{MAX_FRAMES, RETRY_INTERVAL};
pub use entry::vst_plugin_main;
