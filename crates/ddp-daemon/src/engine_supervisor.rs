//! `EngineSupervisor` — owns the backend and the creation-ordered
//! session table (main session = index 0). Every state-side write fans
//! out to all live sessions; zero sessions ⇒ state-only, no engine
//! call. Grows respawn + session init in Slices 08/11/16.

use std::sync::{Arc, Mutex};

use ddp_engine::{Engine, Result, SessionId};

/// Supervises the engine backend on behalf of the daemon.
pub struct EngineSupervisor {
    engine: Arc<dyn Engine>,
    inner: Mutex<Inner>,
}

struct Inner {
    /// Creation-ordered live sessions; index 0 is the main session.
    sessions: Vec<SessionId>,
    /// The engine-facing power state new sessions start under.
    power: bool,
}

impl EngineSupervisor {
    /// Wraps `engine`, mirroring the loaded power state.
    pub fn new(engine: Arc<dyn Engine>, power: bool) -> Self {
        Self {
            engine,
            inner: Mutex::new(Inner {
                sessions: Vec::new(),
                power,
            }),
        }
    }

    /// Creates a session and applies the current power state to it — a
    /// session created while power is off starts disabled.
    ///
    /// # Errors
    ///
    /// Propagates the backend's failure.
    ///
    /// # Panics
    ///
    /// Never in practice: the session lock is not poisoned.
    pub fn create_session(&self, sample_rate: u32) -> Result<SessionId> {
        let mut inner = self.inner.lock().expect("supervisor lock");
        let id = self.engine.create_session(sample_rate)?;
        self.engine.set_enabled(id, inner.power)?;
        inner.sessions.push(id);
        Ok(id)
    }

    /// Fans the power state to every live session
    /// (`EFFECT_CMD_DISABLE` semantics — bypass, parameters survive).
    /// Zero sessions ⇒ no engine call.
    ///
    /// # Errors
    ///
    /// Propagates the backend's first failure.
    ///
    /// # Panics
    ///
    /// Never in practice: the session lock is not poisoned.
    pub fn set_power(&self, on: bool) -> Result<()> {
        let mut inner = self.inner.lock().expect("supervisor lock");
        inner.power = on;
        for &session in &inner.sessions {
            self.engine.set_enabled(session, on)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ddp_engine::{Call, StubBackend};

    #[test]
    fn a_session_created_while_power_is_off_starts_disabled() {
        let stub = Arc::new(StubBackend::new());
        let supervisor = EngineSupervisor::new(stub.clone(), false);
        let id = supervisor.create_session(48000).unwrap();
        assert_eq!(stub.calls()[1], Call::SetEnabled(id, false));
    }

    #[test]
    fn set_power_fans_out_to_every_live_session() {
        let stub = Arc::new(StubBackend::new());
        let supervisor = EngineSupervisor::new(stub.clone(), true);
        let a = supervisor.create_session(48000).unwrap();
        let b = supervisor.create_session(44100).unwrap();
        supervisor.set_power(false).unwrap();
        let disables: Vec<_> = stub
            .calls()
            .into_iter()
            .filter(|call| matches!(call, Call::SetEnabled(_, false)))
            .collect();
        assert_eq!(
            disables,
            vec![Call::SetEnabled(a, false), Call::SetEnabled(b, false)]
        );
    }
}
