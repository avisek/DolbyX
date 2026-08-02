//! DolbyX daemon library: HTTP/WS server + engine supervision, started
//! in-process by `main` and by the integration tests (which inject a
//! `StubBackend` — the one sanctioned seam).

// deny, not forbid: `platform::windows` carries one expected unsafe
// island (pipe security FFI).
#![deny(unsafe_code)]

pub mod audio_server;
pub mod engine_supervisor;
pub mod http_server;
pub mod platform;
pub(crate) mod ws_commands;
pub mod ws_server;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;

use ddp_engine::Engine;
use ddp_persistence::Persistence;
use ddp_state::{ParameterDef, State};
use tokio::net::TcpListener;
use tokio::sync::{RwLock, broadcast, mpsc};
use tokio::task::JoinHandle;

pub use engine_supervisor::{EngineSupervisor, SupervisorError};

use crate::ws_server::ConnId;

/// One queued event fan-out (`state` or `vis`): the originating
/// connection (excluded from delivery — `vis` and non-WS mutations
/// carry a fresh id, so nobody is) plus the pre-serialized event text.
pub(crate) type EventBroadcast = (ConnId, Arc<str>);

/// One engine param batch: values keyed by 4-CC, in `defs` order.
pub(crate) type ParamBatch = Vec<(String, Vec<i16>)>;

/// Everything `Daemon::start` needs — resolved by `main` from CLI flags
/// and platform conventions, or by tests from a tempdir fixture.
#[derive(Debug, Clone)]
pub struct DaemonConfig {
    /// TCP port for `GET /` + `GET /ws`; `0` binds an ephemeral port.
    /// From `--port` (default 9876), never from config.
    pub port: u16,
    /// The UI HTML file served on `GET /` (`--ui` in dev, else
    /// `index.html` beside the binary).
    pub ui_path: PathBuf,
    /// Where `parameters.toml` + `defaults.toml` live (beside the
    /// binary in production).
    pub daemon_dir: PathBuf,
    /// Where `config.toml` lives (platform data dir, or `--config-dir`).
    pub config_dir: PathBuf,
    /// The plugin transport address — a Unix socket path or a Windows
    /// pipe name. From `--socket-path`, defaulting to
    /// [`platform::DEFAULT_SOCKET_PATH`].
    pub socket_path: PathBuf,
}

/// Why the daemon refused to start. Malformed metadata or a missing UI
/// file must fail loudly — never run on stale or partial truth.
#[derive(Debug, thiserror::Error)]
pub enum StartError {
    /// A required file could not be read.
    #[error("read {path}: {source}")]
    Read {
        /// The file that failed.
        path: PathBuf,
        /// The underlying I/O error.
        source: std::io::Error,
    },
    /// `parameters.toml` is malformed.
    #[error("parameters.toml: {0}")]
    ParseParameters(#[from] ddp_state::ParseError),
    /// `defaults.toml` or `config.toml` is malformed.
    #[error(transparent)]
    ParsePersistence(#[from] ddp_persistence::Error),
    /// The listen socket could not be bound — the target follows the
    /// persisted `lan_access` (ADR-0012).
    #[error("bind {addr}: {source}")]
    Bind {
        /// The requested bind address.
        addr: SocketAddr,
        /// The underlying I/O error.
        source: std::io::Error,
    },
    /// The plugin socket (named pipe / Unix socket) could not be bound.
    #[error("bind plugin socket {path}: {source}")]
    BindSocket {
        /// The requested address.
        path: PathBuf,
        /// The underlying I/O error.
        source: std::io::Error,
    },
}

/// Shared per-daemon context: metadata, live state, and the UI path.
pub(crate) struct App {
    /// The 64-entry `ParameterDef` table (single source of truth).
    pub(crate) params: Vec<ParameterDef>,
    /// The table pre-serialized for the bootstrap — static per boot.
    pub(crate) params_json: serde_json::Value,
    /// Live user state.
    pub(crate) state: RwLock<State>,
    /// The engine seam.
    pub(crate) supervisor: Arc<EngineSupervisor>,
    /// `config.toml` write-back.
    pub(crate) persistence: Arc<Persistence>,
    /// The originator-aware event fan-out — `state` + `vis` (ADR-0005).
    pub(crate) updates: broadcast::Sender<EventBroadcast>,
    /// `ConnId` allocator.
    pub(crate) next_conn_id: AtomicU64,
    /// The UI HTML file, re-read on every `GET /`.
    pub(crate) ui_path: PathBuf,
    /// The bound port — fixed at startup (an ephemeral `--port 0`
    /// resolves once, every rebind reuses it); what `lan_url` stamps
    /// into snapshots (issue #71).
    pub(crate) port: u16,
    /// The one HTTP/WS listener's control slot — LAN access flips
    /// rebind it live (ADR-0012); shared with [`Daemon::shutdown`].
    pub(crate) listener: Arc<tokio::sync::Mutex<http_server::HttpListener>>,
    /// The LAN gate's live enforcement (issue #75, ADR-0012):
    /// [`http_server::rebind`] publishes each successful bind into it,
    /// and publishing off *is* the sever — non-loopback WS tasks watch
    /// it, non-loopback HTTP connection tasks register in it.
    pub(crate) lan_gate: Arc<http_server::LanGate>,
}

impl App {
    /// The current snapshot as wire JSON.
    pub(crate) async fn snapshot_json(&self) -> serde_json::Value {
        self.snapshot_json_of(&*self.state.read().await)
    }

    /// Mints a connection identity no other connection holds.
    pub(crate) fn fresh_conn_id(&self) -> ConnId {
        ConnId(
            self.next_conn_id
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        )
    }

    /// Broadcasts a full `state` snapshot to every WS connection — the
    /// non-WS-mutation fan-out (ADR-0005), e.g. a main-session change
    /// refreshing the `readouts`. The originator slot is a fresh
    /// [`ConnId`], so nobody is excluded.
    pub(crate) async fn broadcast_snapshot(&self) {
        let state = self.state.read().await;
        self.queue_state_broadcast(&state, self.fresh_conn_id());
    }

    /// Serializes and queues the full-snapshot `state` broadcast —
    /// call while holding the state lock, so broadcast order always
    /// matches state order; `origin` is excluded from delivery
    /// (ADR-0005).
    pub(crate) fn queue_state_broadcast(&self, state: &State, origin: ConnId) {
        let event = ws_commands::WsEvent::State {
            snapshot: self.snapshot_json_of(state),
            request_id: None,
        }
        .to_text();
        let _ = self.updates.send((origin, event.into()));
    }

    /// Pushes a mutation's engine-visible changes — the power flip
    /// and/or one atomic param batch with the full resolved set as the
    /// replay batch — logging failures: state stays authoritative even
    /// when the engine is down, and the supervisor replays once it
    /// recovers. Returns the last failure for callers that surface it
    /// on the wire.
    pub(crate) fn push_to_engine(
        &self,
        power: Option<bool>,
        params: Option<(ParamBatch, ParamBatch)>,
    ) -> Option<SupervisorError> {
        let mut failure = None;
        if let Some(on) = power
            && let Err(error) = self.supervisor.set_power(on)
        {
            tracing::error!(%error, "engine set_power failed");
            failure = Some(error);
        }
        if let Some((batch, resolved)) = params
            && let Err(error) = self.supervisor.apply_params(&batch, resolved)
        {
            tracing::error!(%error, "engine set_params failed");
            failure = Some(error);
        }
        failure
    }

    /// Applies an externally reloaded state — a `config.toml`
    /// hand-edit the watcher accepted (issue #27): swap the state,
    /// flush the resolved changes to live engine sessions like any
    /// other mutation, and broadcast a fresh snapshot to every client
    /// (no originator to suppress — non-WS source). A `lan_access`
    /// edit rebinds the listener first, exactly like the command path
    /// (issue #70): a failed rebind keeps the previous address *and*
    /// the previous scalar, logged, with no reply (ADR-0012).
    pub(crate) async fn apply_external_reload(self: &Arc<Self>, mut reloaded: State) {
        let mut state = self.state.write().await;
        if state.lan_access != reloaded.lan_access
            && let Err(error) = http_server::rebind(self, reloaded.lan_access).await
        {
            tracing::error!(%error, "lan_access hand-edit: rebind failed, keeping the previous address");
            reloaded.lan_access = state.lan_access;
        }
        let power = (state.power != reloaded.power).then_some(reloaded.power);
        let before = state.resolved_batch(&self.params);
        *state = reloaded;
        let after = state.resolved_batch(&self.params);
        // The engine hears what actually changed — both batches run in
        // `defs` order, so they zip; the replay set is the full
        // resolved profile, as every mutation stores it.
        let batch: ParamBatch = after
            .iter()
            .zip(&before)
            .filter(|(new, old)| new != old)
            .map(|(new, _)| new.clone())
            .collect();
        let params = (!batch.is_empty()).then_some((batch, after));
        let _ = self.push_to_engine(power, params);
        self.queue_state_broadcast(&state, self.fresh_conn_id());
        drop(state);
    }

    /// The full snapshot of `state` as wire JSON: user state (profiles
    /// complete, params keyed by 4-CC) + the `readouts` map — the 8
    /// ReadOnly-Static values live from the main session,
    /// `ParameterDef.default` while zero sessions (or for a dead ref
    /// the engine reads empty) — + the discovery `lan_url` (issue #71,
    /// ADR-0012), derived here like the readouts: recomputed per
    /// serialization, populated regardless of the toggle, never a
    /// `State` field.
    pub(crate) fn snapshot_json_of(&self, state: &State) -> serde_json::Value {
        let live = self.supervisor.readouts();
        let readouts: serde_json::Map<String, serde_json::Value> = self
            .params
            .iter()
            .filter(|def| def.access == ddp_state::ParamAccess::ReadOnlyStatic)
            .map(|def| {
                let value = live.get(&def.name).unwrap_or(&def.default);
                (def.name.clone(), serde_json::json!(value))
            })
            .collect();
        let profiles: Vec<serde_json::Value> = state
            .profiles
            .iter()
            .map(|profile| {
                serde_json::json!({
                    "id": profile.id,
                    "name": profile.name,
                    "is_factory": profile.is_factory,
                    "selected_eq_preset": profile.content.selected_eq_preset,
                    "params": profile.content.params,
                    // What resolves beneath the item's config.toml row,
                    // content-shaped (ADR-0005): divergence — resolved
                    // ≠ baseline per content key — is client-derived,
                    // never shipped (originator suppression would
                    // starve a precomputed list on the editing tab).
                    "baseline": profile.baseline,
                })
            })
            .collect();
        let eq_presets: Vec<serde_json::Value> = state
            .eq_presets
            .iter()
            .map(|preset| {
                serde_json::json!({
                    "id": preset.id,
                    "name": preset.name,
                    "is_factory": preset.is_factory,
                    "params": preset.content.params,
                    "baseline": preset.baseline,
                })
            })
            .collect();
        serde_json::json!({
            "power": state.power,
            "lan_access": state.lan_access,
            "lan_url": http_server::lan_url(self.port),
            "selected_profile": state.selected_profile,
            "profiles": profiles,
            "eq_presets": eq_presets,
            "readouts": readouts,
        })
    }
}

/// A running daemon: bound address + server tasks + engine seam.
pub struct Daemon {
    addr: SocketAddr,
    supervisor: Arc<EngineSupervisor>,
    persistence: Arc<Persistence>,
    /// The listener control slot, shared with the app — a LAN access
    /// flip may have swapped the accept task since startup, so
    /// shutdown takes whatever currently serves (ADR-0012).
    listener: Arc<tokio::sync::Mutex<http_server::HttpListener>>,
    audio_server: JoinHandle<std::convert::Infallible>,
    vis_bridge: JoinHandle<()>,
    reload_bridge: JoinHandle<()>,
}

impl Daemon {
    /// Loads metadata + defaults, verifies the UI file, binds the port,
    /// and serves. Returns once the socket is live.
    ///
    /// # Errors
    ///
    /// [`StartError`] on any unreadable/malformed startup file or an
    /// unbindable port — the refuse-to-start policy.
    ///
    /// # Panics
    ///
    /// Never in practice: a parsed `ParameterDef` table always
    /// serializes to JSON.
    pub async fn start(config: DaemonConfig, engine: Arc<dyn Engine>) -> Result<Self, StartError> {
        let read = |path: PathBuf| match std::fs::read_to_string(&path) {
            Ok(document) => Ok(document),
            Err(source) => Err(StartError::Read { path, source }),
        };

        let params = ddp_state::parse(&read(config.daemon_dir.join("parameters.toml"))?)?;
        let defaults = ddp_persistence::parse_defaults(
            &read(config.daemon_dir.join("defaults.toml"))?,
            &params,
        )?;
        // Refuse-to-start probe; served requests re-read from disk.
        let _ = read(config.ui_path.clone())?;

        let persistence = Arc::new(Persistence::open(
            &config.config_dir,
            defaults,
            params.clone(),
        )?);
        let state = persistence.load();
        let readout_names = params
            .iter()
            .filter(|def| def.access == ddp_state::ParamAccess::ReadOnlyStatic)
            .map(|def| def.name.clone())
            .collect();
        // Session init pushes the selected profile's full resolved set —
        // the commit-leaf touch reshapes the engine's 10-band power-on
        // state to the 20-band config in that same write.
        let supervisor = Arc::new(EngineSupervisor::new(
            engine,
            state.power,
            state.resolved_batch(&params),
            readout_names,
        ));
        // Startup binds per the persisted `lan_access` (issue #70,
        // ADR-0012): loopback off, all interfaces on — the target is
        // hardcoded, resolved from state alone.
        let bind_addr = SocketAddr::from((http_server::bind_target(state.lan_access), config.port));
        let bind_error = move |source| StartError::Bind {
            addr: bind_addr,
            source,
        };
        let listener = TcpListener::bind(bind_addr).await.map_err(bind_error)?;
        let addr = listener.local_addr().map_err(bind_error)?;

        // The gate opens on what actually got bound (issue #75).
        let lan_gate = Arc::new(http_server::LanGate::new(state.lan_access));
        let app = Arc::new(App {
            params_json: serde_json::to_value(&params).expect("defs always serialize"),
            params,
            state: RwLock::new(state),
            supervisor: supervisor.clone(),
            persistence: persistence.clone(),
            updates: broadcast::channel(64).0,
            next_conn_id: AtomicU64::new(0),
            ui_path: config.ui_path,
            port: addr.port(),
            listener: Arc::new(tokio::sync::Mutex::new(http_server::HttpListener {
                serve: None,
            })),
            lan_gate,
        });

        // The slot fills before any rebind source exists (the watcher
        // below, WS commands via this very task) — a flip must always
        // find the accept task it awaits (issue #70).
        app.listener.lock().await.serve = Some(http_server::spawn_serve(listener, app.clone()));

        // The config.toml watcher (issue #27): accepted external
        // reloads land on the app through one channel, so they apply
        // in arrival order.
        let (reload_tx, mut reload_rx) = mpsc::unbounded_channel();
        persistence.watch(move |state| {
            let _ = reload_tx.send(state);
        })?;
        let reload_app = app.clone();
        let reload_bridge = tokio::spawn(async move {
            while let Some(state) = reload_rx.recv().await {
                reload_app.apply_external_reload(state).await;
            }
        });

        let plugins = platform::PluginListener::bind(&config.socket_path).map_err(|source| {
            StartError::BindSocket {
                path: config.socket_path.clone(),
                source,
            }
        })?;
        tracing::info!(socket = %config.socket_path.display(), "plugin socket bound");

        let audio_server = tokio::spawn(audio_server::accept_loop(plugins, app.clone()));
        let vis_bridge = tokio::spawn(ws_server::vis_bridge(app.clone()));

        Ok(Self {
            addr,
            supervisor,
            persistence,
            listener: app.listener.clone(),
            audio_server,
            vis_bridge,
            reload_bridge,
        })
    }

    /// The engine seam — tests create sessions here; the audio server
    /// joins in Slice 11 ([#19](https://github.com/avisek/DolbyX/issues/19)).
    #[must_use]
    pub const fn supervisor(&self) -> &Arc<EngineSupervisor> {
        &self.supervisor
    }

    /// The bound listen address.
    #[must_use]
    pub const fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// Stops serving and flushes any pending `config.toml` write — the
    /// graceful-shutdown path.
    pub async fn shutdown(self) {
        // Take *and* stop the accept task under the slot lock, so a
        // racing LAN access flip either completes first or finds the
        // empty slot and stands down (never a resurrected listener).
        {
            let mut slot = self.listener.lock().await;
            if let Some(serve) = slot.serve.take() {
                serve.abort();
                let _ = serve.await;
            }
        }
        self.audio_server.abort();
        self.vis_bridge.abort();
        self.reload_bridge.abort();
        let _ = self.audio_server.await;
        let _ = self.vis_bridge.await;
        let _ = self.reload_bridge.await;
        self.persistence.shutdown().await;
    }
}
