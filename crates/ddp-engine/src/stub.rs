//! `StubBackend` — records calls, fabricates replies; the one
//! sanctioned test seam (issue #12 mock policy). Its `process` contract
//! is pinned for every later slice: enabled → deterministic marker
//! transform (bitwise NOT — ferried audio stays distinguishable from
//! dry passthrough), disabled → echo (bypass identity), vis tail
//! fabricated.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::{Engine, EngineError, Result, SessionId, VisFrame};

/// One recorded backend call, in issue order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Call {
    /// `create_session` — carries the id it returned.
    CreateSession {
        /// The requested sample rate.
        sample_rate: u32,
        /// The allocated session.
        id: SessionId,
    },
    /// `destroy_session`.
    DestroySession(SessionId),
    /// `set_enabled`.
    SetEnabled(SessionId, bool),
}

/// A per-session stub registry.
#[derive(Debug, Default)]
struct Session {
    enabled: bool,
    params: HashMap<String, Vec<i16>>,
}

/// The recording fake backend.
#[derive(Debug, Default)]
pub struct StubBackend {
    inner: Mutex<Inner>,
}

#[derive(Debug, Default)]
struct Inner {
    next_id: u32,
    sessions: HashMap<SessionId, Session>,
    calls: Vec<Call>,
}

impl StubBackend {
    /// A fresh stub with no sessions and no recorded calls.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Every call recorded so far, in order.
    ///
    /// # Panics
    ///
    /// Never in practice: the internal lock cannot be poisoned by this
    /// panic-free backend.
    #[must_use]
    pub fn calls(&self) -> Vec<Call> {
        self.inner.lock().expect("stub lock").calls.clone()
    }
}

impl Engine for StubBackend {
    fn create_session(&self, sample_rate: u32) -> Result<SessionId> {
        let mut inner = self.inner.lock().expect("stub lock");
        let id = SessionId(inner.next_id);
        inner.next_id += 1;
        inner.sessions.insert(id, Session::default());
        inner.calls.push(Call::CreateSession { sample_rate, id });
        Ok(id)
    }

    fn destroy_session(&self, id: SessionId) -> Result<()> {
        let mut inner = self.inner.lock().expect("stub lock");
        inner
            .sessions
            .remove(&id)
            .ok_or(EngineError::SessionNotFound(id))?;
        inner.calls.push(Call::DestroySession(id));
        Ok(())
    }

    fn set_enabled(&self, id: SessionId, enabled: bool) -> Result<()> {
        let mut inner = self.inner.lock().expect("stub lock");
        inner
            .sessions
            .get_mut(&id)
            .ok_or(EngineError::SessionNotFound(id))?
            .enabled = enabled;
        inner.calls.push(Call::SetEnabled(id, enabled));
        Ok(())
    }

    fn set_params(&self, id: SessionId, params: &[(&str, &[i16])]) -> Result<()> {
        let mut inner = self.inner.lock().expect("stub lock");
        let session = inner
            .sessions
            .get_mut(&id)
            .ok_or(EngineError::SessionNotFound(id))?;
        for (name, values) in params {
            session.params.insert((*name).to_string(), values.to_vec());
        }
        Ok(())
    }

    fn get_params(&self, id: SessionId, names: &[&str]) -> Result<Vec<Vec<i16>>> {
        let inner = self.inner.lock().expect("stub lock");
        let session = inner
            .sessions
            .get(&id)
            .ok_or(EngineError::SessionNotFound(id))?;
        Ok(names
            .iter()
            .map(|name| session.params.get(*name).cloned().unwrap_or_default())
            .collect())
    }

    fn process(&self, id: SessionId, input: &[i16], output: &mut [i16]) -> Result<VisFrame> {
        assert_eq!(
            input.len(),
            output.len(),
            "process contract: output buffer mirrors input"
        );
        let inner = self.inner.lock().expect("stub lock");
        let session = inner
            .sessions
            .get(&id)
            .ok_or(EngineError::SessionNotFound(id))?;
        if session.enabled {
            for (out, sample) in output.iter_mut().zip(input) {
                *out = !*sample;
            }
        } else {
            output.copy_from_slice(input);
        }
        Ok(fabricated_vis())
    }
}

/// The deterministic vis tail every stub `process` reply carries: four
/// distinguishable ramps, `vnbg` 0–19 through `vcbe` 60–79.
#[must_use]
pub fn fabricated_vis() -> VisFrame {
    let ramp = |base: i16| {
        let mut value = base;
        std::array::from_fn(|_| {
            let current = value;
            value = value.wrapping_add(1);
            current
        })
    };
    VisFrame {
        vnbg: ramp(0),
        vnbe: ramp(20),
        vcbg: ramp(40),
        vcbe: ramp(60),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Engine;

    #[test]
    fn create_session_allocates_distinct_recorded_sessions() {
        let stub = StubBackend::new();
        let a = stub.create_session(48000).unwrap();
        let b = stub.create_session(44100).unwrap();
        assert_ne!(a, b);
        assert_eq!(
            stub.calls(),
            vec![
                Call::CreateSession {
                    sample_rate: 48000,
                    id: a
                },
                Call::CreateSession {
                    sample_rate: 44100,
                    id: b
                },
            ]
        );
    }

    #[test]
    fn set_enabled_is_recorded_per_session() {
        let stub = StubBackend::new();
        let id = stub.create_session(48000).unwrap();
        stub.set_enabled(id, true).unwrap();
        stub.set_enabled(id, false).unwrap();
        assert_eq!(
            stub.calls()[1..],
            [Call::SetEnabled(id, true), Call::SetEnabled(id, false)]
        );
    }

    #[test]
    fn process_when_enabled_applies_the_marker_transform() {
        let stub = StubBackend::new();
        let id = stub.create_session(48000).unwrap();
        stub.set_enabled(id, true).unwrap();
        let input = [0_i16, -1, 32767, -32768];
        let mut output = [0_i16; 4];
        let _ = stub.process(id, &input, &mut output).unwrap();
        // Bitwise NOT: ferried audio is distinguishable from passthrough.
        assert_eq!(output, [-1, 0, -32768, 32767]);
    }

    #[test]
    fn process_when_disabled_echoes_the_input() {
        let stub = StubBackend::new();
        let id = stub.create_session(48000).unwrap();
        let input = [7_i16, -7, 1234, -1234];
        let mut output = [0_i16; 4];
        let _ = stub.process(id, &input, &mut output).unwrap();
        assert_eq!(output, input, "bypass is the identity");
    }

    #[test]
    fn process_fabricates_a_deterministic_vis_tail() {
        let stub = StubBackend::new();
        let id = stub.create_session(48000).unwrap();
        let vis = stub.process(id, &[0, 0], &mut [0, 0]).unwrap();
        assert_eq!(vis, fabricated_vis());
        assert_eq!(vis.vnbg[..3], [0, 1, 2]);
        assert_eq!(vis.vcbe[19], 79);
    }

    #[test]
    fn calls_against_an_unknown_session_are_rejected() {
        let stub = StubBackend::new();
        let ghost = SessionId(99);
        let error = stub.set_enabled(ghost, true).unwrap_err();
        assert_eq!(error, EngineError::SessionNotFound(ghost));
        assert_eq!(error.to_string(), "unknown session 99");
        assert!(stub.process(ghost, &[0, 0], &mut [0, 0]).is_err());
        assert!(stub.destroy_session(ghost).is_err());
        assert!(stub.calls().is_empty(), "rejected calls are not recorded");
    }

    #[test]
    fn destroyed_sessions_stop_existing() {
        let stub = StubBackend::new();
        let id = stub.create_session(48000).unwrap();
        stub.destroy_session(id).unwrap();
        assert_eq!(
            stub.set_enabled(id, true),
            Err(EngineError::SessionNotFound(id))
        );
    }

    #[test]
    fn get_params_returns_what_set_params_wrote() {
        let stub = StubBackend::new();
        let id = stub.create_session(48000).unwrap();
        stub.set_params(id, &[("dvla", &[4_i16][..]), ("gebg", &[1, 2, 3])])
            .unwrap();
        let values = stub.get_params(id, &["dvla", "gebg", "geon"]).unwrap();
        assert_eq!(values, vec![vec![4], vec![1, 2, 3], vec![]]);
    }
}
