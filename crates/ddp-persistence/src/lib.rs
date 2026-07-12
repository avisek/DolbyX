//! TOML overlay persistence: defaults/config cascade, debounced
//! write-back, file watcher (ADR-0007).
//!
//! The full five-layer cascade is here (Slice 10,
//! [#18](https://github.com/avisek/DolbyX/issues/18)); the watcher
//! lands in Slice 19 ([#27](https://github.com/avisek/DolbyX/issues/27)).

#![forbid(unsafe_code)]

pub mod debounce;
pub mod schema;

use std::path::{Path, PathBuf};

use ddp_state::{Defaults, ParameterDef, State};
use tokio::sync::{mpsc, oneshot};

pub use debounce::DEBOUNCE;
pub use schema::{ConfigOverlay, parse_config, parse_defaults, resolve, serialize_overlay};

use crate::debounce::Msg;

/// Why persistence failed to load or parse.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// `defaults.toml` is malformed or fails validation — the daemon
    /// refuses to start.
    #[error("defaults.toml: {0}")]
    Defaults(String),
    /// `config.toml` is malformed or fails validation — the daemon
    /// refuses to start rather than silently discard user state.
    #[error("config.toml: {0}")]
    Config(String),
    /// The config dir or `config.toml` itself is not usable.
    #[error("{path}: {source}")]
    Io {
        /// The offending path.
        path: PathBuf,
        /// The underlying I/O error.
        source: std::io::Error,
    },
}

/// `config.toml` ownership: load at startup, creation on first run,
/// debounced write-back, flush on shutdown.
pub struct Persistence {
    defaults: Defaults,
    defs: Vec<ParameterDef>,
    overlay: ConfigOverlay,
    tx: mpsc::UnboundedSender<Msg>,
}

impl Persistence {
    /// Opens the config dir (creating it and an empty `config.toml` on a
    /// fresh install — the watcher and hand-editing need the file to
    /// exist), reads the overlay, and starts the debounced writer.
    /// `defs` is the `ParameterDef` table every stored param validates
    /// against.
    ///
    /// Must run inside a tokio runtime.
    ///
    /// # Errors
    ///
    /// [`Error::Io`] when the dir or file is not usable;
    /// [`Error::Config`] when the overlay is malformed (refuse to start
    /// rather than silently discard user state).
    pub fn open(
        config_dir: &Path,
        defaults: Defaults,
        defs: Vec<ParameterDef>,
    ) -> Result<Self, Error> {
        let io = |path: &Path| {
            let path = path.to_path_buf();
            move |source| Error::Io { path, source }
        };
        std::fs::create_dir_all(config_dir).map_err(io(config_dir))?;
        let config_path = config_dir.join("config.toml");
        if !config_path.exists() {
            std::fs::write(&config_path, "").map_err(io(&config_path))?;
        }
        let document = std::fs::read_to_string(&config_path).map_err(io(&config_path))?;
        let overlay = parse_config(&document, &defs, &defaults)?;
        let (tx, rx) = mpsc::unbounded_channel();
        drop(tokio::spawn(debounce::writer(config_path, rx)));
        Ok(Self {
            defaults,
            defs,
            overlay,
            tx,
        })
    }

    /// The state this boot runs: the `config.toml` overlay resolved
    /// over the factory defaults, every profile complete.
    #[must_use]
    pub fn load(&self) -> State {
        resolve(&self.defaults, &self.overlay)
    }

    /// Queues a debounced write-back of `state`'s divergence from what
    /// resolves beneath it (500 ms shared window; per-item write-back,
    /// hand-edited shared layers preserved verbatim).
    pub fn flush(&self, state: &State) {
        let document = serialize_overlay(state, &self.defaults, &self.overlay, &self.defs);
        let _ = self.tx.send(Msg::Write(document));
    }

    /// Flushes any pending write immediately — the graceful-shutdown
    /// path (SIGTERM / console close).
    pub async fn shutdown(&self) {
        let (ack, done) = oneshot::channel();
        if self.tx.send(Msg::Flush(ack)).is_ok() {
            let _ = done.await;
        }
    }
}
