//! Per-platform plugin transports behind one shape: Windows named pipe
//! (`\\.\pipe\DolbyX`) and Unix socket (`/run/dolbyx/dolbyx.sock`) —
//! two adapters, a real seam (epic #8). Each module exports
//! [`PluginListener`], [`PluginStream`], and [`DEFAULT_SOCKET_PATH`];
//! everything protocol-side stays transport-agnostic in
//! [`crate::audio_server`].

#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
pub use unix::{DEFAULT_SOCKET_PATH, PluginListener, PluginStream};
#[cfg(windows)]
pub use windows::{DEFAULT_SOCKET_PATH, PluginListener, PluginStream};
