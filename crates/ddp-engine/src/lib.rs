//! Engine seam: the `Engine` trait plus stub and QEMU backends.
//!
//! The trait + `StubBackend` are this crate's surface for Slice 04;
//! `QemuBackend` lands in Slice 08
//! ([#16](https://github.com/avisek/DolbyX/issues/16)).

#![forbid(unsafe_code)]

pub mod protocol;
pub mod stub;

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
