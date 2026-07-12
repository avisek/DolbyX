//! DolbyX daemon library: HTTP/WS server + engine supervision, started
//! in-process by `main` and by the integration tests (which inject a
//! `StubBackend` — the one sanctioned seam).

#![forbid(unsafe_code)]

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
use tokio::sync::{RwLock, broadcast};
use tokio::task::JoinHandle;

pub use engine_supervisor::{EngineSupervisor, SupervisorError};

use crate::ws_server::ConnId;

/// One queued `state` fan-out: the originating connection (excluded
/// from delivery) plus the pre-serialized event text.
pub(crate) type StateBroadcast = (ConnId, Arc<str>);

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
    /// The listen socket could not be bound.
    #[error("bind 127.0.0.1:{port}: {source}")]
    Bind {
        /// The requested port.
        port: u16,
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
    /// The originator-aware `state` fan-out (ADR-0005).
    pub(crate) updates: broadcast::Sender<StateBroadcast>,
    /// `ConnId` allocator.
    pub(crate) next_conn_id: AtomicU64,
    /// The UI HTML file, re-read on every `GET /`.
    pub(crate) ui_path: PathBuf,
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
        let event = ws_commands::WsEvent::State {
            snapshot: self.snapshot_json().await,
        }
        .to_text();
        let _ = self.updates.send((self.fresh_conn_id(), event.into()));
    }

    /// The full snapshot of `state` as wire JSON: user state (profiles
    /// complete, params keyed by 4-CC) + the `readouts` map — the 8
    /// ReadOnly-Static values live from the main session,
    /// `ParameterDef.default` while zero sessions (or for a dead ref
    /// the engine reads empty).
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
                    "selected_eq_preset": profile.selected_eq_preset,
                    "params": profile.params,
                })
            })
            .collect();
        serde_json::json!({
            "power": state.power,
            "selected_profile": state.selected_profile,
            "profiles": profiles,
            "readouts": readouts,
        })
    }
}

/// A running daemon: bound address + server tasks + engine seam.
pub struct Daemon {
    addr: SocketAddr,
    supervisor: Arc<EngineSupervisor>,
    persistence: Arc<Persistence>,
    server: JoinHandle<()>,
    audio_server: JoinHandle<std::convert::Infallible>,
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
        let app = Arc::new(App {
            params_json: serde_json::to_value(&params).expect("defs always serialize"),
            params,
            state: RwLock::new(state),
            supervisor: supervisor.clone(),
            persistence: persistence.clone(),
            updates: broadcast::channel(64).0,
            next_conn_id: AtomicU64::new(0),
            ui_path: config.ui_path,
        });

        let bind_error = |source| StartError::Bind {
            port: config.port,
            source,
        };
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, config.port))
            .await
            .map_err(bind_error)?;
        let addr = listener.local_addr().map_err(bind_error)?;
        let plugins = platform::PluginListener::bind(&config.socket_path).map_err(|source| {
            StartError::BindSocket {
                path: config.socket_path.clone(),
                source,
            }
        })?;
        tracing::info!(socket = %config.socket_path.display(), "plugin socket bound");

        let audio_server = tokio::spawn(audio_server::accept_loop(plugins, app.clone()));
        let router = http_server::router(app);
        let server = tokio::spawn(async move {
            if let Err(error) = axum::serve(listener, router).await {
                tracing::error!(%error, "http server exited");
            }
        });

        Ok(Self {
            addr,
            supervisor,
            persistence,
            server,
            audio_server,
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
        self.server.abort();
        self.audio_server.abort();
        let _ = self.server.await;
        let _ = self.audio_server.await;
        self.persistence.shutdown().await;
    }
}
