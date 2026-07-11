//! `session_id` → effect handle: one shared engine process multiplexes
//! every session (epic #8). Ids are minted here, monotonically, never
//! reused within a shim's lifetime.

use std::collections::HashMap;

use ddp_engine::protocol::{STATUS_INVALID, STATUS_NO_SESSION};

use crate::ffi::{Effect, EngineLib};

/// The rates `Effect_reinit` honours. Anything else *silently falls
/// back to 44100 while replying success* (`setconfig_probe` Sc5), so
/// the shim rejects up front — the engine never sees a bad rate.
const SUPPORTED_RATES: [u32; 3] = [44_100, 48_000, 32_000];

/// The live sessions, keyed by shim-minted id.
pub struct SessionTable<'lib> {
    lib: &'lib EngineLib,
    next_id: u32,
    sessions: HashMap<u32, Effect<'lib>>,
}

impl<'lib> SessionTable<'lib> {
    /// An empty table minting ids from 1.
    pub fn new(lib: &'lib EngineLib) -> Self {
        Self {
            lib,
            next_id: 1,
            sessions: HashMap::new(),
        }
    }

    /// Creates a session: effect handle → `EFFECT_CMD_INIT` → one
    /// `EFFECT_CMD_SET_CONFIG` at `sample_rate` (stereo + PCM16 +
    /// WRITE pinned). No `DEFINE_PARAMS` / `DEFINE_SETTINGS` handshake
    /// — ever (ADR-0010). The session starts disabled, as the engine
    /// leaves it.
    ///
    /// # Errors
    ///
    /// [`STATUS_INVALID`] for an unsupported rate; otherwise the
    /// engine's own status. A half-initialised handle is released
    /// before returning.
    pub fn create(&mut self, sample_rate: u32) -> Result<u32, i32> {
        if !SUPPORTED_RATES.contains(&sample_rate) {
            return Err(STATUS_INVALID);
        }
        let id = self.next_id;
        let android_session = i32::try_from(id).map_err(|_| STATUS_INVALID)?;
        let mut effect = self.lib.create_effect(android_session)?;
        effect.init()?; // Err drops `effect` → handle released
        effect.set_config(sample_rate)?;
        self.next_id += 1;
        self.sessions.insert(id, effect);
        Ok(id)
    }

    /// Releases a session's handle.
    ///
    /// # Errors
    ///
    /// [`STATUS_NO_SESSION`] when `id` names no live session.
    pub fn destroy(&mut self, id: u32) -> Result<(), i32> {
        self.sessions
            .remove(&id)
            .map(drop) // Effect::drop releases the handle
            .ok_or(STATUS_NO_SESSION)
    }

    /// The session's effect, for enable/disable and process.
    ///
    /// # Errors
    ///
    /// [`STATUS_NO_SESSION`] when `id` names no live session.
    pub fn get_mut(&mut self, id: u32) -> Result<&mut Effect<'lib>, i32> {
        self.sessions.get_mut(&id).ok_or(STATUS_NO_SESSION)
    }
}
