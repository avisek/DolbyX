//! TOML overlay persistence: defaults/config cascade, throttled
//! write-back, `config.toml` watcher (ADR-0007).
//!
//! The five-layer cascade is Slice 10
//! ([#18](https://github.com/avisek/DolbyX/issues/18)); the live
//! two-way `config.toml` sync — leading-edge write throttle, notify
//! watcher, byte-compare self-write suppression — is Slice 19
//! ([#27](https://github.com/avisek/DolbyX/issues/27)).

#![forbid(unsafe_code)]

pub mod file_watcher;
pub mod schema;
pub mod throttle;

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use ddp_state::{Defaults, ParameterDef, State};
use tokio::sync::{mpsc, oneshot};

pub use schema::{ConfigOverlay, parse_config, parse_defaults, resolve, serialize_overlay};

use crate::throttle::Msg;

/// The shared cadence window — both directions run one shape (issue
/// #27): the write side throttles to at most one disk touch per window
/// (leading edge — an idle mutation lands immediately), the read side
/// coalesces watcher events into one reload per window. Sustained
/// change either way tracks at ~10 Hz.
pub const WINDOW: Duration = Duration::from_millis(100);

/// Why persistence failed to load or parse.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// `defaults.toml` is malformed or fails validation — the daemon
    /// refuses to start.
    #[error("defaults.toml: {0}")]
    Defaults(String),
    /// `config.toml` is malformed or fails validation — at startup the
    /// daemon refuses to start rather than silently discard user
    /// state; mid-run the watcher keeps last-good state.
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
    /// The `config.toml` watcher could not be created or attached.
    #[error("config.toml watcher: {0}")]
    Watch(String),
}

/// The `config.toml` bytes both directions sync on (issue #27): the
/// write side records exactly what it lands, the read side compares at
/// window fire — equal ⇒ self-echo, different ⇒ external edit. Never
/// timing: a quiet window would swallow hand-edits made during UI
/// activity. The epoch counts accepted external contents, so a
/// document serialized before a reload can never land after it (an
/// accepted reload is a hard cutover — the file is truth).
pub(crate) struct SyncedFile {
    path: PathBuf,
    inner: Mutex<Synced>,
}

/// [`SyncedFile`]'s guarded half.
struct Synced {
    /// The last bytes written to — or accepted from — the file.
    bytes: Vec<u8>,
    /// Bumped on every foreign read.
    epoch: u64,
}

/// What a [`SyncedFile::read`] found at window fire.
pub(crate) enum ReadOutcome {
    /// The file holds the synced bytes — a self-write echo (or no
    /// change at all).
    Clean,
    /// External contents — now recorded as the synced bytes (even when
    /// they later fail to parse, so a UI mutation may overwrite a
    /// broken file: last-writer-wins), with the epoch bumped.
    Foreign(Vec<u8>),
    /// The file is gone (vim's save dance has a transient no-file
    /// window; deletion is more often accident than intent).
    Absent,
    /// The file exists but could not be read.
    Unreadable(std::io::Error),
}

impl SyncedFile {
    fn new(path: PathBuf, bytes: Vec<u8>) -> Self {
        Self {
            path,
            inner: Mutex::new(Synced { bytes, epoch: 0 }),
        }
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    /// The current reload epoch — snapshot when serializing a
    /// write-back document.
    pub(crate) fn epoch(&self) -> u64 {
        self.inner.lock().expect("file sync lock").epoch
    }

    /// Writes `document` by atomic replace — serialize to
    /// `config.toml.tmp` (same dir), rename over `config.toml`, so a
    /// crash mid-write can never leave a truncated file. No fsync:
    /// preference data; the page cache coalesces physical writes.
    ///
    /// The write yields — file untouched — when a reload cut over
    /// since the document was serialized (`epoch` is stale) or the
    /// file holds foreign bytes the watcher has not reloaded yet
    /// (behavior 6, issue #27: the hand-edit wins). I/O failures are
    /// logged, never fatal — the daemon keeps serving from memory.
    pub(crate) fn write(&self, document: &str, epoch: u64) {
        let mut inner = self.inner.lock().expect("file sync lock");
        if inner.epoch != epoch {
            tracing::debug!("write-back dropped: an external reload cut over");
            return;
        }
        if let Ok(bytes) = std::fs::read(&self.path)
            && bytes != inner.bytes
        {
            tracing::debug!("write-back yielded: the file holds an unreloaded external edit");
            return;
        }
        let tmp = self.path.with_extension("toml.tmp");
        let replace =
            std::fs::write(&tmp, document).and_then(|()| std::fs::rename(&tmp, &self.path));
        match replace {
            Ok(()) => inner.bytes = document.as_bytes().to_vec(),
            Err(error) => {
                tracing::error!(path = %self.path.display(), %error, "config.toml write failed");
            }
        }
    }

    /// Reads the file once and classifies it against the synced bytes
    /// — the read side's window-fire primitive.
    pub(crate) fn read(&self) -> ReadOutcome {
        let mut inner = self.inner.lock().expect("file sync lock");
        match std::fs::read(&self.path) {
            Ok(bytes) if bytes == inner.bytes => ReadOutcome::Clean,
            Ok(bytes) => {
                inner.bytes.clone_from(&bytes);
                inner.epoch += 1;
                ReadOutcome::Foreign(bytes)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => ReadOutcome::Absent,
            Err(error) => ReadOutcome::Unreadable(error),
        }
    }
}

/// The state `Persistence` shares with its writer and watcher tasks.
///
/// Lock order where both are held: `overlay` before `file` — `flush`
/// snapshots the epoch under the overlay lock and the watcher swaps
/// the overlay around its read, so a reload and a flush serialize
/// against each other.
pub(crate) struct Shared {
    pub(crate) defaults: Defaults,
    pub(crate) defs: Vec<ParameterDef>,
    /// The loaded overlay — swapped wholesale when the watcher accepts
    /// an external edit; `flush` re-emits its shared layers verbatim.
    pub(crate) overlay: Mutex<ConfigOverlay>,
    pub(crate) file: std::sync::Arc<SyncedFile>,
}

/// `config.toml` ownership: load at startup, creation on first run,
/// throttled write-back (100 ms leading edge, atomic replace), the
/// live watcher, flush on shutdown.
pub struct Persistence {
    shared: std::sync::Arc<Shared>,
    tx: mpsc::UnboundedSender<Msg>,
    /// The running watcher task — aborted on drop (and with it the OS
    /// watch); daemons come and go in tests.
    watcher: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl Persistence {
    /// Opens the config dir (creating it and an empty `config.toml` on a
    /// fresh install — the watcher and hand-editing need the file to
    /// exist), reads the overlay, and starts the throttled writer.
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
        let file = std::sync::Arc::new(SyncedFile::new(config_path, document.into_bytes()));
        let (tx, rx) = mpsc::unbounded_channel();
        drop(tokio::spawn(throttle::writer(file.clone(), rx)));
        Ok(Self {
            shared: std::sync::Arc::new(Shared {
                defaults,
                defs,
                overlay: Mutex::new(overlay),
                file,
            }),
            tx,
            watcher: Mutex::new(None),
        })
    }

    /// The state this boot runs: the `config.toml` overlay resolved
    /// over the factory defaults, every profile complete.
    ///
    /// # Panics
    ///
    /// Never in practice: the overlay lock is not poisoned.
    #[must_use]
    pub fn load(&self) -> State {
        let overlay = self.shared.overlay.lock().expect("overlay lock");
        resolve(&self.shared.defaults, &overlay)
    }

    /// Queues a write-back of `state`'s divergence from what resolves
    /// beneath it (100 ms leading-edge throttle — an idle mutation
    /// lands immediately, a drag rewrites at ~10 Hz; per-item
    /// write-back, hand-edited shared layers preserved verbatim). An
    /// external reload accepted meanwhile supersedes it — the file is
    /// truth at that instant.
    ///
    /// # Panics
    ///
    /// Never in practice: the overlay lock is not poisoned.
    pub fn flush(&self, state: &State) {
        let (document, epoch) = {
            let overlay = self.shared.overlay.lock().expect("overlay lock");
            (
                serialize_overlay(state, &self.shared.defaults, &overlay, &self.shared.defs),
                self.shared.file.epoch(),
            )
        };
        let _ = self.tx.send(Msg::Write(document, epoch));
    }

    /// Starts the `config.toml` watcher (issue #27): `on_reload`
    /// receives the freshly resolved [`State`] whenever an external
    /// edit is accepted. Self-writes suppress by byte compare;
    /// malformed or absent contents keep last-good state (an empty
    /// file is valid — factory state). At most one watcher runs; a
    /// second call replaces the first.
    ///
    /// # Errors
    ///
    /// [`Error::Watch`] when the OS watcher cannot be created or
    /// attached.
    ///
    /// # Panics
    ///
    /// Never in practice: the watcher slot lock is not poisoned.
    pub fn watch(&self, on_reload: impl Fn(State) + Send + 'static) -> Result<(), Error> {
        let task = file_watcher::spawn(self.shared.clone(), on_reload)?;
        if let Some(old) = self.watcher.lock().expect("watcher slot").replace(task) {
            old.abort();
        }
        Ok(())
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

impl Drop for Persistence {
    fn drop(&mut self) {
        if let Some(task) = self.watcher.lock().expect("watcher slot").take() {
            task.abort();
        }
    }
}
