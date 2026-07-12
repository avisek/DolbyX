//! Engine seam: the `Engine` trait plus stub and QEMU backends.
//!
//! `QemuBackend` is the real engine and the daemon's default;
//! `StubBackend` stays as the fast inner-loop test seam (issue #12
//! mock policy).

#![forbid(unsafe_code)]

pub mod protocol;
pub mod qemu;
pub mod stub;
#[cfg(feature = "qemu")]
pub mod test_support;

pub use qemu::QemuBackend;
pub use stub::{Call, StubBackend};

/// A live engine session — one per plugin instance, sample rate fixed
/// for its lifetime.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SessionId(pub u32);

/// The four ReadOnly-Dynamic arrays every `process` reply carries
/// (`vnbg ‖ vnbe ‖ vcbg ‖ vcbe`, 4 × 20 i16).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VisFrame {
    /// Native-grid per-band EQ gains.
    pub vnbg: [i16; 20],
    /// Native-grid per-band spectrum excitations.
    pub vnbe: [i16; 20],
    /// Custom-grid per-band EQ gains.
    pub vcbg: [i16; 20],
    /// Custom-grid per-band spectrum excitations.
    pub vcbe: [i16; 20],
}

/// Why a backend call failed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EngineError {
    /// The session id names no live session.
    #[error("unknown session {}", .0.0)]
    SessionNotFound(SessionId),
    /// Host-side validation rejected the call before the engine saw it
    /// — the engine's own handling would be a footgun (a bad rate
    /// silently falls back to 44100; mono poisons the handle).
    #[error("unsupported config: {0}")]
    UnsupportedConfig(String),
    /// The engine (or its shim) refused the operation; `status` is the
    /// reply status verbatim.
    #[error("engine rejected the operation (status {status})")]
    Rejected {
        /// The non-zero reply status, e.g. `-22` (`-EINVAL`).
        status: i32,
    },
    /// The engine subprocess died (or its stream desynced). The backend
    /// respawns lazily on the next call; every session was lost with
    /// the process — the supervisor recreates and replays them.
    #[error("engine subprocess crashed: {0}")]
    Crashed(String),
}

/// Backend result.
pub type Result<T> = std::result::Result<T, EngineError>;

/// The canonical engine seam (epic #8): batch-only param surface, every
/// `process` reply carrying a [`VisFrame`]. Implementations hide
/// subprocess lifecycle, protocol framing, and the session table.
pub trait Engine: Send + Sync {
    /// Creates a session at a fixed sample rate.
    ///
    /// # Errors
    ///
    /// Backend-specific; the stub never fails here.
    fn create_session(&self, sample_rate: u32) -> Result<SessionId>;

    /// Destroys a session.
    ///
    /// # Errors
    ///
    /// [`EngineError::SessionNotFound`] when `id` names no live session.
    fn destroy_session(&self, id: SessionId) -> Result<()>;

    /// Enables (process) or disables (bypass) a session.
    ///
    /// # Errors
    ///
    /// [`EngineError::SessionNotFound`] when `id` names no live session.
    fn set_enabled(&self, id: SessionId, enabled: bool) -> Result<()>;

    /// Writes one atomic batch of name-addressed parameter values.
    ///
    /// # Errors
    ///
    /// [`EngineError::SessionNotFound`] when `id` names no live session.
    fn set_params(&self, id: SessionId, params: &[(&str, &[i16])]) -> Result<()>;

    /// Reads the live registry values for `names`, in order.
    ///
    /// # Errors
    ///
    /// [`EngineError::SessionNotFound`] when `id` names no live session.
    fn get_params(&self, id: SessionId, names: &[&str]) -> Result<Vec<Vec<i16>>>;

    /// Processes one interleaved-stereo PCM block (`output.len()` must
    /// equal `input.len()`), returning the block's vis tail.
    ///
    /// # Errors
    ///
    /// [`EngineError::SessionNotFound`] when `id` names no live session.
    fn process(&self, id: SessionId, input: &[i16], output: &mut [i16]) -> Result<VisFrame>;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Behavior 3 (issue #16): host-side rejections carry a clear,
    /// actionable message — the error *is* the interface.
    #[test]
    fn engine_errors_read_as_clear_messages() {
        assert_eq!(
            EngineError::SessionNotFound(SessionId(9)).to_string(),
            "unknown session 9"
        );
        assert_eq!(
            EngineError::UnsupportedConfig(
                "sample rate 96000 outside the engine's {44100, 48000, 32000}".into()
            )
            .to_string(),
            "unsupported config: sample rate 96000 outside the engine's {44100, 48000, 32000}"
        );
        assert_eq!(
            EngineError::Rejected { status: -22 }.to_string(),
            "engine rejected the operation (status -22)"
        );
        assert_eq!(
            EngineError::Crashed("engine shim closed the stream".into()).to_string(),
            "engine subprocess crashed: engine shim closed the stream"
        );
    }
}
