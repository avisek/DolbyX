//! `EngineSupervisor` — owns the backend and the creation-ordered
//! session table (main session = index 0). External session ids are
//! minted here and stay stable across engine respawns — transparent to
//! `AudioServer`/UI. Every state-side write fans out to all live
//! sessions; zero sessions ⇒ state-only, no engine call. Every
//! main-session block fans its vis tail out to the `vis` subscribers
//! (issue #24) — process-driven, never timed.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use ddp_engine::{Engine, EngineError, SessionId, VisFrame};
use tokio::sync::broadcast;

/// Vis frames a subscriber may fall behind before it skips ahead —
/// ~0.6 s of buffer at a 100-block/s host. Skipping loses nothing: the
/// client renders from the latest frame anyway.
const VIS_CHANNEL_CAPACITY: usize = 64;

/// Why a supervisor operation failed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SupervisorError {
    /// The engine crashed and the one recovery attempt failed too —
    /// the backend is down until a later call manages to respawn it.
    #[error("engine crashed and recovery failed: {0}")]
    EngineCrashed(String),
    /// The session init sequence (create → params → enable) failed.
    #[error("session init failed: {0}")]
    SessionInitFailed(#[source] EngineError),
    /// The session id names no live session.
    #[error("unknown session {}", .0.0)]
    SessionNotFound(SessionId),
    /// A non-crash engine failure outside session init, verbatim.
    #[error(transparent)]
    Engine(EngineError),
}

impl SupervisorError {
    /// The engine's reply status, when the failure carries one — the
    /// wire `error` event's optional `status` field.
    #[must_use]
    pub const fn engine_status(&self) -> Option<i32> {
        match self {
            Self::SessionInitFailed(EngineError::Rejected { status })
            | Self::Engine(EngineError::Rejected { status }) => Some(*status),
            _ => None,
        }
    }
}

/// Supervisor result.
pub type Result<T> = std::result::Result<T, SupervisorError>;

/// One live session: the stable external id the daemon hands out, the
/// backend id it currently maps to (changes on respawn), and the rate
/// it was created at (immutable — respawn recreates at the same rate).
struct Session {
    external: SessionId,
    backend: SessionId,
    sample_rate: u32,
}

/// Supervises the engine backend on behalf of the daemon.
pub struct EngineSupervisor {
    engine: Arc<dyn Engine>,
    /// The 8 ReadOnly-Static 4-CCs read from the main session.
    readout_names: Vec<String>,
    /// The `vis` fan-out (issue #24): one frame per main-session block,
    /// pure event stream — no audio ⇒ nothing sent, no timer anywhere.
    vis: broadcast::Sender<VisFrame>,
    inner: Mutex<Inner>,
}

struct Inner {
    /// Creation-ordered live sessions; index 0 is the main session.
    sessions: Vec<Session>,
    /// The next external id to mint.
    next_external: u32,
    /// The engine-facing power state new sessions start under.
    power: bool,
    /// The resolved active profile — the batch every session init (and
    /// respawn replay) writes. Empty until Slice 10
    /// ([#18](https://github.com/avisek/DolbyX/issues/18)) grows
    /// `State`'s resolution.
    resolved_params: Vec<(String, Vec<i16>)>,
    /// Live ReadOnly-Static values from the main session; empty with
    /// zero sessions (snapshots then fall back to `ParameterDef.default`).
    readouts: HashMap<String, Vec<i16>>,
}

impl EngineSupervisor {
    /// Wraps `engine`, mirroring the loaded power state and the
    /// resolved active profile; `readout_names` are the ReadOnly-Static
    /// 4-CCs read from the main session.
    pub fn new(
        engine: Arc<dyn Engine>,
        power: bool,
        resolved_params: Vec<(String, Vec<i16>)>,
        readout_names: Vec<String>,
    ) -> Self {
        Self {
            engine,
            readout_names,
            vis: broadcast::channel(VIS_CHANNEL_CAPACITY).0,
            inner: Mutex::new(Inner {
                sessions: Vec::new(),
                next_external: 0,
                power,
                resolved_params,
                readouts: HashMap::new(),
            }),
        }
    }

    /// Creates and initialises a session — create (INIT + `SET_CONFIG`
    /// at `sample_rate`, shim-side) → one `set_params` of the resolved
    /// active profile → `set_enabled(power)`, so a session created
    /// while power is off starts disabled. Returns the stable external
    /// id. The first session becomes the main session and fills the
    /// readouts.
    ///
    /// # Errors
    ///
    /// [`SupervisorError::SessionInitFailed`] when the sequence fails;
    /// [`SupervisorError::EngineCrashed`] when the engine crashed and
    /// recovery failed.
    ///
    /// # Panics
    ///
    /// Never in practice: the supervisor lock is not poisoned.
    pub fn create_session(&self, sample_rate: u32) -> Result<SessionId> {
        let mut inner = self.inner.lock().expect("supervisor lock");
        let backend = match self.init_backend_session(&inner, sample_rate) {
            Ok(backend) => backend,
            Err(EngineError::Crashed(_)) => {
                self.recover(&mut inner)?;
                match self.init_backend_session(&inner, sample_rate) {
                    Ok(backend) => backend,
                    Err(EngineError::Crashed(message)) => {
                        return Err(SupervisorError::EngineCrashed(message));
                    }
                    Err(error) => return Err(SupervisorError::SessionInitFailed(error)),
                }
            }
            Err(error) => return Err(SupervisorError::SessionInitFailed(error)),
        };
        let external = SessionId(inner.next_external);
        inner.next_external += 1;
        inner.sessions.push(Session {
            external,
            backend,
            sample_rate,
        });
        if inner.sessions.len() == 1 {
            match self.refresh_readouts(&mut inner) {
                Ok(()) => {}
                // Crash while reading: recovery rebuilds the session
                // and re-reads for us. If it fails, un-mint the session
                // — the caller never learns this id, so leaving it in
                // the table would ghost-replay it on later recoveries.
                Err(EngineError::Crashed(_)) => {
                    if let Err(error) = self.recover(&mut inner) {
                        inner.sessions.pop();
                        return Err(error);
                    }
                }
                Err(error) => tracing::warn!(%error, "main-session readouts unavailable"),
            }
        }
        Ok(external)
    }

    /// Destroys a session by its external id. When the main session
    /// dies the next-oldest takes over and the readouts re-read.
    ///
    /// # Errors
    ///
    /// [`SupervisorError::SessionNotFound`] when `id` names no live
    /// session; [`SupervisorError::EngineCrashed`] when the engine
    /// crashed and recovery failed.
    ///
    /// # Panics
    ///
    /// Never in practice: the supervisor lock is not poisoned.
    pub fn destroy_session(&self, id: SessionId) -> Result<()> {
        let mut inner = self.inner.lock().expect("supervisor lock");
        let index = inner
            .sessions
            .iter()
            .position(|session| session.external == id)
            .ok_or(SupervisorError::SessionNotFound(id))?;
        let session = inner.sessions.remove(index);
        match self.engine.destroy_session(session.backend) {
            Ok(()) => {}
            // The dead process took the handle with it; recovery
            // rebuilds the remaining sessions and re-reads readouts.
            Err(EngineError::Crashed(_)) => return self.recover(&mut inner),
            Err(error) => return Err(SupervisorError::Engine(error)),
        }
        if index == 0
            && let Err(error) = self.refresh_readouts(&mut inner)
        {
            tracing::warn!(%error, "main-session readouts unavailable");
        }
        Ok(())
    }

    /// Fans the power state to every live session
    /// (`EFFECT_CMD_DISABLE` semantics — bypass, parameters survive).
    /// Zero sessions ⇒ no engine call.
    ///
    /// # Errors
    ///
    /// [`SupervisorError::EngineCrashed`] when the engine crashed and
    /// recovery failed; [`SupervisorError::Engine`] on any other
    /// backend failure.
    ///
    /// # Panics
    ///
    /// Never in practice: the supervisor lock is not poisoned.
    pub fn set_power(&self, on: bool) -> Result<()> {
        let mut inner = self.inner.lock().expect("supervisor lock");
        inner.power = on;
        for index in 0..inner.sessions.len() {
            match self.engine.set_enabled(inner.sessions[index].backend, on) {
                Ok(()) => {}
                // Recovery replays `on` onto every rebuilt session —
                // the fan-out is already done when it returns.
                Err(EngineError::Crashed(_)) => return self.recover(&mut inner),
                Err(error) => return Err(SupervisorError::Engine(error)),
            }
        }
        Ok(())
    }

    /// Fans one atomic param batch to every live session and stores
    /// `resolved` — the selected profile's full set — as the batch
    /// every future session init and crash recovery replays. Zero
    /// sessions ⇒ store only, no engine call.
    ///
    /// # Errors
    ///
    /// [`SupervisorError::EngineCrashed`] when the engine crashed and
    /// recovery failed (recovery itself replays `resolved` onto every
    /// rebuilt session); [`SupervisorError::Engine`] on any other
    /// backend failure.
    ///
    /// # Panics
    ///
    /// Never in practice: the supervisor lock is not poisoned.
    pub fn apply_params(
        &self,
        batch: &[(String, Vec<i16>)],
        resolved: Vec<(String, Vec<i16>)>,
    ) -> Result<()> {
        let mut inner = self.inner.lock().expect("supervisor lock");
        inner.resolved_params = resolved;
        let borrowed: Vec<(&str, &[i16])> = batch
            .iter()
            .map(|(name, values)| (name.as_str(), values.as_slice()))
            .collect();
        for index in 0..inner.sessions.len() {
            match self
                .engine
                .set_params(inner.sessions[index].backend, &borrowed)
            {
                Ok(()) => {}
                // Recovery re-inits every session with the just-stored
                // resolved set — the fan-out is done when it returns.
                Err(EngineError::Crashed(_)) => return self.recover(&mut inner),
                Err(error) => return Err(SupervisorError::Engine(error)),
            }
        }
        Ok(())
    }

    /// Reads params from a session (by its external id) — the live
    /// clamped registry, the only true per-param getter. Diagnostics
    /// and the e2e suites use this to prove what the engine holds.
    ///
    /// # Errors
    ///
    /// [`SupervisorError::SessionNotFound`] when `id` names no live
    /// session; [`SupervisorError::Engine`] on a backend failure (no
    /// recovery — a read loses nothing).
    ///
    /// # Panics
    ///
    /// Never in practice: the supervisor lock is not poisoned.
    pub fn get_params(&self, id: SessionId, names: &[&str]) -> Result<Vec<Vec<i16>>> {
        let inner = self.inner.lock().expect("supervisor lock");
        let session = inner
            .sessions
            .iter()
            .find(|session| session.external == id)
            .ok_or(SupervisorError::SessionNotFound(id))?;
        self.engine
            .get_params(session.backend, names)
            .map_err(SupervisorError::Engine)
    }

    /// Processes one interleaved-stereo PCM block on a session (by its
    /// external id), returning the block's vis tail.
    ///
    /// # Errors
    ///
    /// [`SupervisorError::SessionNotFound`] when `id` names no live
    /// session; [`SupervisorError::EngineCrashed`] when the engine
    /// crashed and recovery failed; [`SupervisorError::Engine`] on any
    /// other backend failure.
    ///
    /// # Panics
    ///
    /// Never in practice: the supervisor lock is not poisoned.
    pub fn process(&self, id: SessionId, input: &[i16], output: &mut [i16]) -> Result<VisFrame> {
        let mut inner = self.inner.lock().expect("supervisor lock");
        let index = inner
            .sessions
            .iter()
            .position(|session| session.external == id)
            .ok_or(SupervisorError::SessionNotFound(id))?;
        let vis = match self
            .engine
            .process(inner.sessions[index].backend, input, output)
        {
            Ok(vis) => vis,
            Err(EngineError::Crashed(_)) => {
                // The block was lost with the process; recover, then
                // retry it once on the rebuilt session.
                self.recover(&mut inner)?;
                self.engine
                    .process(inner.sessions[index].backend, input, output)
                    .map_err(|error| match error {
                        EngineError::Crashed(message) => SupervisorError::EngineCrashed(message),
                        other => SupervisorError::Engine(other),
                    })?
            }
            Err(error) => return Err(SupervisorError::Engine(error)),
        };
        if index == 0 {
            let _ = self.vis.send(vis.clone()); // no subscribers is fine
        }
        Ok(vis)
    }

    /// Subscribes to the `vis` event stream: the vis tail of every
    /// processed block, verbatim. Pure event stream — no audio ⇒ no
    /// frames; idle is the client's to derive (issue #24). A lagged
    /// subscriber skips ahead; frames are superseded, never awaited.
    #[must_use]
    pub fn subscribe_vis(&self) -> broadcast::Receiver<VisFrame> {
        self.vis.subscribe()
    }

    /// The live ReadOnly-Static values from the main session, keyed by
    /// 4-CC — empty with zero sessions.
    ///
    /// # Panics
    ///
    /// Never in practice: the supervisor lock is not poisoned.
    #[must_use]
    pub fn readouts(&self) -> HashMap<String, Vec<i16>> {
        self.inner.lock().expect("supervisor lock").readouts.clone()
    }

    /// The main session's external id — the oldest live session, which
    /// sources the readouts and the `vis` events. `None` with zero
    /// sessions. A change here means the snapshot's `readouts` changed
    /// — the caller broadcasts.
    ///
    /// # Panics
    ///
    /// Never in practice: the supervisor lock is not poisoned.
    #[must_use]
    pub fn main_session(&self) -> Option<SessionId> {
        let inner = self.inner.lock().expect("supervisor lock");
        inner.sessions.first().map(|session| session.external)
    }

    /// Runs the init sequence against the backend, returning the
    /// backend session id. A handle that fails mid-init is released —
    /// never left half-alive engine-side.
    fn init_backend_session(
        &self,
        inner: &Inner,
        sample_rate: u32,
    ) -> ddp_engine::Result<SessionId> {
        let backend = self.engine.create_session(sample_rate)?;
        let batch: Vec<(&str, &[i16])> = inner
            .resolved_params
            .iter()
            .map(|(name, values)| (name.as_str(), values.as_slice()))
            .collect();
        let init = self
            .engine
            .set_params(backend, &batch)
            .and_then(|()| self.engine.set_enabled(backend, inner.power));
        if let Err(error) = init {
            let _ = self.engine.destroy_session(backend); // best effort
            return Err(error);
        }
        Ok(backend)
    }

    /// Rebuilds the world on a fresh engine process: every live session
    /// recreated at its rate, in creation order, through the full init
    /// sequence (resolved params + current power), then the readouts
    /// re-read — external ids untouched. One attempt; a failure inside
    /// recovery is [`SupervisorError::EngineCrashed`], never a loop.
    fn recover(&self, inner: &mut Inner) -> Result<()> {
        let crashed = |error: EngineError| SupervisorError::EngineCrashed(error.to_string());
        tracing::warn!(
            sessions = inner.sessions.len(),
            "engine crashed; rebuilding sessions on the respawned process"
        );
        for index in 0..inner.sessions.len() {
            let sample_rate = inner.sessions[index].sample_rate;
            let backend = self
                .init_backend_session(inner, sample_rate)
                .map_err(crashed)?;
            inner.sessions[index].backend = backend;
        }
        self.refresh_readouts(inner).map_err(crashed)?;
        Ok(())
    }

    /// Re-reads the readouts from the main session (empty values —
    /// dead refs — are dropped so snapshots fall back to defaults);
    /// clears them when no session is live.
    fn refresh_readouts(&self, inner: &mut Inner) -> ddp_engine::Result<()> {
        let Some(main) = inner.sessions.first() else {
            inner.readouts.clear();
            return Ok(());
        };
        let names: Vec<&str> = self.readout_names.iter().map(String::as_str).collect();
        let values = self.engine.get_params(main.backend, &names)?;
        inner.readouts = self
            .readout_names
            .iter()
            .zip(values)
            .filter(|(_, values)| !values.is_empty())
            .map(|(name, values)| (name.clone(), values))
            .collect();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ddp_engine::{Call, StubBackend};

    /// The session init sequence (issue #16, per ADR-0010): create
    /// (INIT + `SET_CONFIG` shim-side) → one `set_params` of the resolved
    /// active profile → `set_enabled(power)` — params land before the
    /// engine un-bypasses, so the profile is audible from block one.
    #[test]
    fn session_init_runs_create_params_enable_in_order() {
        let stub = Arc::new(StubBackend::new());
        let supervisor = EngineSupervisor::new(
            stub.clone(),
            true,
            vec![("dvla".into(), vec![4]), ("deon".into(), vec![1])],
            Vec::new(),
        );
        let id = supervisor.create_session(48000).unwrap();
        assert_eq!(id, SessionId(0), "external ids mint from 0");
        assert_eq!(
            stub.calls(),
            vec![
                Call::CreateSession {
                    sample_rate: 48000,
                    id: SessionId(0),
                },
                Call::SetParams(
                    SessionId(0),
                    vec![("dvla".into(), vec![4]), ("deon".into(), vec![1])],
                ),
                Call::SetEnabled(SessionId(0), true),
            ],
        );
    }

    #[test]
    fn a_session_created_while_power_is_off_starts_disabled() {
        let stub = Arc::new(StubBackend::new());
        let supervisor = EngineSupervisor::new(stub.clone(), false, Vec::new(), Vec::new());
        let id = supervisor.create_session(48000).unwrap();
        assert_eq!(stub.calls()[2], Call::SetEnabled(id, false));
    }

    /// Real readouts (issue #16): filled from the main session at init;
    /// dead refs (empty reads) are dropped so snapshots keep defaults.
    #[test]
    fn main_session_init_fills_the_readouts_from_the_engine() {
        let engine = Arc::new(StubBackend::seeded(vec![
            ("ver".into(), vec![2, 0, 4, 0]),
            ("vnnb".into(), vec![0]),
        ]));
        let supervisor = EngineSupervisor::new(
            engine,
            true,
            Vec::new(),
            vec!["ver".into(), "vnnb".into(), "ghost".into()],
        );
        assert!(supervisor.readouts().is_empty(), "zero sessions ⇒ empty");
        supervisor.create_session(48000).unwrap();
        let readouts = supervisor.readouts();
        assert_eq!(readouts["ver"], vec![2, 0, 4, 0]);
        assert_eq!(readouts["vnnb"], vec![0]);
        assert!(
            !readouts.contains_key("ghost"),
            "dead refs read empty and are dropped"
        );
    }

    /// Main session = oldest live session: on its death the next-oldest
    /// takes over and the readouts re-read (epic invariant — the
    /// rate-derived grid may differ); the last death clears them.
    #[test]
    fn destroying_the_main_session_rereads_readouts_from_the_next_oldest() {
        let engine = Arc::new(StubBackend::seeded(vec![("vnnb".into(), vec![0])]));
        let supervisor =
            EngineSupervisor::new(engine.clone(), true, Vec::new(), vec!["vnnb".into()]);
        assert_eq!(supervisor.main_session(), None, "zero sessions ⇒ no main");
        let first = supervisor.create_session(48000).unwrap();
        let second = supervisor.create_session(44100).unwrap();
        assert_eq!(supervisor.main_session(), Some(first), "oldest is main");

        // Sharpen the second session's registry so the handover is
        // observable ([20] once the grid has filled ≠ power-on [0]).
        engine.set_params(SessionId(1), &[("vnnb", &[20])]).unwrap();

        supervisor.destroy_session(first).unwrap();
        assert_eq!(
            supervisor.main_session(),
            Some(second),
            "next-oldest takes over"
        );
        assert_eq!(
            supervisor.readouts()["vnnb"],
            vec![20],
            "next-oldest session sources the readouts"
        );

        supervisor.destroy_session(second).unwrap();
        assert_eq!(supervisor.main_session(), None);
        assert!(supervisor.readouts().is_empty(), "no sessions ⇒ cleared");
        assert_eq!(
            supervisor.destroy_session(second),
            Err(SupervisorError::SessionNotFound(second)),
            "destroyed ids stop existing"
        );
    }

    fn crashed() -> EngineError {
        EngineError::Crashed("killed".into())
    }

    /// Slice 10 (issue #18): a param batch fans out to every live
    /// session, and the stored resolved set feeds later session inits.
    #[test]
    fn apply_params_fans_out_and_reseeds_future_inits() {
        let stub = Arc::new(StubBackend::new());
        let supervisor = EngineSupervisor::new(
            stub.clone(),
            true,
            vec![("dvla".into(), vec![4])],
            Vec::new(),
        );
        let a = supervisor.create_session(48000).unwrap();
        let b = supervisor.create_session(44100).unwrap();

        let edit = vec![("dvla".to_string(), vec![7_i16])];
        supervisor.apply_params(&edit, edit.clone()).unwrap();
        let fanned: Vec<_> = stub
            .calls()
            .into_iter()
            .filter(|call| matches!(call, Call::SetParams(_, batch) if *batch == edit))
            .collect();
        assert_eq!(
            fanned,
            vec![
                Call::SetParams(a, edit.clone()),
                Call::SetParams(b, edit.clone()),
            ],
            "every live session hears the batch"
        );

        // A later session initializes on the new resolved set.
        let c = supervisor.create_session(48000).unwrap();
        assert!(stub.calls().contains(&Call::SetParams(c, edit)));
    }

    /// Zero sessions ⇒ a param change is state-only; it lands at the
    /// next session init (epic invariant).
    #[test]
    fn apply_params_with_zero_sessions_stores_without_an_engine_call() {
        let stub = Arc::new(StubBackend::new());
        let supervisor = EngineSupervisor::new(stub.clone(), true, Vec::new(), Vec::new());
        let batch = vec![("dvla".to_string(), vec![9_i16])];
        supervisor.apply_params(&batch, batch.clone()).unwrap();
        assert!(stub.calls().is_empty(), "no engine call without sessions");

        supervisor.create_session(48000).unwrap();
        assert!(stub.calls().contains(&Call::SetParams(SessionId(0), batch)));
    }

    /// A crash mid-fan-out recovers onto the *new* resolved set — the
    /// store-then-fan order is load-bearing.
    #[test]
    fn a_crash_during_apply_params_replays_the_new_values() {
        let stub = Arc::new(StubBackend::new());
        let supervisor = EngineSupervisor::new(
            stub.clone(),
            true,
            vec![("dvla".into(), vec![4])],
            Vec::new(),
        );
        supervisor.create_session(48000).unwrap();

        let switched = vec![("dvla".to_string(), vec![7_i16])];
        stub.fail_next(crashed());
        supervisor
            .apply_params(&switched, switched.clone())
            .unwrap();

        // The rebuilt session was initialised with the new set, not the
        // one it was created under.
        assert_eq!(
            stub.calls().last(),
            Some(&Call::SetEnabled(SessionId(1), true)),
            "recovery re-ran the full init"
        );
        assert!(
            stub.calls()
                .contains(&Call::SetParams(SessionId(1), switched))
        );
    }

    /// Respawn on crash (issue #16): the supervisor recreates every
    /// live session at its rate, in creation order, and replays the
    /// resolved params + the current enable state onto the fresh
    /// process — while the external ids keep working.
    #[test]
    fn a_crash_during_set_power_recreates_every_session_and_replays_state() {
        let stub = Arc::new(StubBackend::new());
        let supervisor = EngineSupervisor::new(
            stub.clone(),
            true,
            vec![("dvla".into(), vec![4])],
            Vec::new(),
        );
        let a = supervisor.create_session(48000).unwrap();
        let b = supervisor.create_session(44100).unwrap();

        stub.fail_next(crashed());
        supervisor.set_power(false).unwrap();

        // The recovery tail: both sessions rebuilt through the full
        // init sequence, already under the new power state.
        let calls = stub.calls();
        let batch = vec![("dvla".to_string(), vec![4_i16])];
        assert_eq!(
            calls[6..],
            [
                Call::CreateSession {
                    sample_rate: 48000,
                    id: SessionId(2),
                },
                Call::SetParams(SessionId(2), batch.clone()),
                Call::SetEnabled(SessionId(2), false),
                Call::CreateSession {
                    sample_rate: 44100,
                    id: SessionId(3),
                },
                Call::SetParams(SessionId(3), batch),
                Call::SetEnabled(SessionId(3), false),
            ],
        );

        // External ids are stable: they now route to the rebuilt
        // (disabled ⇒ echo) sessions, not the lost enabled ones.
        let input = [1_i16, 2, 3, 4];
        let mut output = [0_i16; 4];
        supervisor.process(a, &input, &mut output).unwrap();
        assert_eq!(output, input, "a routes to the rebuilt session");
        supervisor.process(b, &input, &mut output).unwrap();
        assert_eq!(output, input, "b routes to the rebuilt session");
    }

    /// A crash mid-`create_session` recovers the existing sessions and
    /// retries the new session's init once.
    #[test]
    fn a_crash_during_create_recovers_and_retries_the_init_once() {
        let stub = Arc::new(StubBackend::new());
        let supervisor = EngineSupervisor::new(stub.clone(), true, Vec::new(), Vec::new());
        let a = supervisor.create_session(48000).unwrap();

        stub.fail_next(crashed());
        let b = supervisor.create_session(44100).unwrap();
        assert_eq!(b, SessionId(1), "external ids keep minting in order");

        // Both sessions live and enabled (power on): the stub's marker
        // transform is bitwise NOT, so [5, -5] → [-6, 4].
        let input = [5_i16, -5];
        let mut output = [0_i16; 2];
        supervisor.process(a, &input, &mut output).unwrap();
        assert_eq!(output, [-6, 4], "a survived the recovery");
        supervisor.process(b, &input, &mut output).unwrap();
        assert_eq!(output, [-6, 4], "b landed on the fresh process");
    }

    /// One recovery attempt per call: a crash during recovery itself
    /// surfaces as `EngineCrashed` — never an unbounded retry loop.
    #[test]
    fn a_crash_during_recovery_surfaces_engine_crashed() {
        let stub = Arc::new(StubBackend::new());
        let supervisor = EngineSupervisor::new(stub.clone(), true, Vec::new(), Vec::new());
        supervisor.create_session(48000).unwrap();

        stub.fail_next(crashed());
        stub.fail_next(crashed());
        assert!(matches!(
            supervisor.set_power(false),
            Err(SupervisorError::EngineCrashed(_))
        ));
    }

    /// A crash while filling the readouts, with recovery failing too,
    /// must not ghost the just-created session — its id was never
    /// handed out, so nothing may replay it on later recoveries.
    #[test]
    fn a_failed_recovery_during_readout_fill_leaves_no_ghost_session() {
        let stub = Arc::new(StubBackend::new());
        let supervisor = EngineSupervisor::new(stub.clone(), true, Vec::new(), vec!["ver".into()]);
        stub.ok_calls(3); // create, set_params, set_enabled…
        stub.fail_next(crashed()); // …the readout read crashes…
        stub.fail_next(crashed()); // …and so does the recovery.
        assert!(matches!(
            supervisor.create_session(48000),
            Err(SupervisorError::EngineCrashed(_))
        ));

        // No ghost: a power flip fans out to nothing.
        supervisor.set_power(false).unwrap();
        assert!(
            !stub
                .calls()
                .iter()
                .any(|call| matches!(call, Call::SetEnabled(_, false))),
            "no session survived the failed create"
        );
    }

    /// A non-crash init failure is `SessionInitFailed`: no half-alive
    /// session is left behind, host-side or engine-side.
    #[test]
    fn a_rejected_init_leaves_no_session_behind() {
        let stub = Arc::new(StubBackend::new());
        let supervisor = EngineSupervisor::new(stub.clone(), true, Vec::new(), Vec::new());

        stub.ok_calls(1); // create succeeds…
        stub.fail_next(EngineError::Rejected { status: -22 }); // …set_params doesn't
        let error = supervisor.create_session(48000).unwrap_err();
        assert!(matches!(
            error,
            SupervisorError::SessionInitFailed(EngineError::Rejected { status: -22 })
        ));
        assert_eq!(error.engine_status(), Some(-22));

        // The orphaned engine handle was released, and the supervisor
        // holds no session: a power flip makes no engine call.
        assert!(
            stub.calls().contains(&Call::DestroySession(SessionId(0))),
            "the half-initialised handle is released"
        );
        supervisor.set_power(false).unwrap();
        assert!(
            !stub
                .calls()
                .iter()
                .any(|call| matches!(call, Call::SetEnabled(..))),
            "no session survived the failed init"
        );
    }

    #[test]
    fn process_routes_by_external_id() {
        let stub = Arc::new(StubBackend::new());
        let supervisor = EngineSupervisor::new(stub, true, Vec::new(), Vec::new());
        let id = supervisor.create_session(48000).unwrap();
        let input = [1_i16, 2, 3, 4];
        let mut output = [0_i16; 4];
        let vis = supervisor.process(id, &input, &mut output).unwrap();
        assert_eq!(output, [!1, !2, !3, !4], "stub marker transform");
        assert_eq!(vis, ddp_engine::stub::fabricated_vis());
        assert_eq!(
            supervisor.process(SessionId(99), &input, &mut output),
            Err(SupervisorError::SessionNotFound(SessionId(99)))
        );
    }

    /// Behavior 1 (issue #24): a main-session block fans its vis frame
    /// out to every subscriber, verbatim — process-driven, not
    /// power-gated: a bypassed block still emits.
    #[test]
    fn a_main_session_block_fans_its_vis_frame_to_subscribers() {
        let stub = Arc::new(StubBackend::new());
        let supervisor = EngineSupervisor::new(stub, true, Vec::new(), Vec::new());
        let mut vis = supervisor.subscribe_vis();
        let main = supervisor.create_session(48000).unwrap();

        let mut output = [0_i16; 2];
        supervisor.process(main, &[7, -7], &mut output).unwrap();
        assert_eq!(vis.try_recv(), Ok(ddp_engine::stub::fabricated_vis()));

        supervisor.set_power(false).unwrap();
        supervisor.process(main, &[7, -7], &mut output).unwrap();
        assert_eq!(
            vis.try_recv(),
            Ok(ddp_engine::stub::fabricated_vis()),
            "bypassed blocks still emit"
        );
    }

    /// Behavior 2 (issue #24): a non-main session's blocks emit
    /// nothing — the main session is the one vis source, so two hosts
    /// never interleave frames.
    #[test]
    fn a_non_main_session_block_emits_no_vis_frame() {
        let stub = Arc::new(StubBackend::new());
        let supervisor = EngineSupervisor::new(stub, true, Vec::new(), Vec::new());
        let mut vis = supervisor.subscribe_vis();
        let _main = supervisor.create_session(48000).unwrap();
        let other = supervisor.create_session(44100).unwrap();

        let mut output = [0_i16; 2];
        supervisor.process(other, &[7, -7], &mut output).unwrap();
        assert_eq!(
            vis.try_recv(),
            Err(broadcast::error::TryRecvError::Empty),
            "only the main session sources vis"
        );
    }

    /// Behavior 4 (issue #24): when the main session dies the
    /// next-oldest takes over as the vis source.
    #[test]
    fn the_next_oldest_session_sources_vis_after_the_mains_death() {
        let stub = Arc::new(StubBackend::new());
        let supervisor = EngineSupervisor::new(stub, true, Vec::new(), Vec::new());
        let mut vis = supervisor.subscribe_vis();
        let first = supervisor.create_session(48000).unwrap();
        let second = supervisor.create_session(44100).unwrap();

        supervisor.destroy_session(first).unwrap();
        let mut output = [0_i16; 2];
        supervisor.process(second, &[7, -7], &mut output).unwrap();
        assert_eq!(vis.try_recv(), Ok(ddp_engine::stub::fabricated_vis()));
    }

    #[test]
    fn set_power_fans_out_to_every_live_session() {
        let stub = Arc::new(StubBackend::new());
        let supervisor = EngineSupervisor::new(stub.clone(), true, Vec::new(), Vec::new());
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
