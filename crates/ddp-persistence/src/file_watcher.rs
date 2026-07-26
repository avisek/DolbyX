//! The `config.toml` watcher (issue #27): a `notify` watch on the
//! parent dir feeding a 100 ms trailing-edge window — one reload per
//! window, a sustained external writer tracks at ~10 Hz, and the delay
//! lets editor save dances (truncate-then-write) complete before the
//! read. Self-writes suppress by byte compare, never timing.
//! `defaults.toml` and `parameters.toml` stay startup-only reads — an
//! edit there takes a daemon restart (ADR-0007).

use std::sync::Arc;

use ddp_state::State;
use notify::Watcher as _;
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::{Error, ReadOutcome, Shared, WINDOW, parse_config, resolve};

/// Creates the OS watcher and spawns the window task. The watch covers
/// the parent dir, filtered to `config.toml` by name: rename-replace
/// (our own atomic writes, vim-style saves) swaps the inode, so a
/// watch on the file itself goes deaf.
pub(crate) fn spawn(
    shared: Arc<Shared>,
    on_reload: impl Fn(State) + Send + 'static,
) -> Result<tokio::task::JoinHandle<()>, Error> {
    let dir = shared
        .file
        .path()
        .parent()
        .expect("config.toml always sits in a directory")
        .to_path_buf();
    let (tx, rx) = mpsc::unbounded_channel();
    let mut watcher = notify::recommended_watcher(move |event| {
        // The runtime side hung up ⇒ nothing left to notify.
        let _ = tx.send(event);
    })
    .map_err(|error| Error::Watch(error.to_string()))?;
    watcher
        .watch(&dir, notify::RecursiveMode::NonRecursive)
        .map_err(|error| Error::Watch(error.to_string()))?;
    Ok(tokio::spawn(run(watcher, shared, rx, on_reload)))
}

/// Runs the read side: qualifying events coalesce into a trailing-edge
/// [`WINDOW`] — armed by the first event, not reset by later ones, so
/// a sustained writer never starves — and each fire resolves at most
/// one reload. Owns `watcher`: aborting the task (`Persistence` drop)
/// releases the OS watch.
async fn run(
    watcher: notify::RecommendedWatcher,
    shared: Arc<Shared>,
    mut rx: mpsc::UnboundedReceiver<notify::Result<notify::Event>>,
    on_reload: impl Fn(State),
) {
    let _hold = watcher;
    let mut deadline = Instant::now();
    let mut armed = false;
    loop {
        tokio::select! {
            event = rx.recv() => {
                let Some(event) = event else { return };
                if touches_config(&event) && !armed {
                    armed = true;
                    deadline = Instant::now() + WINDOW;
                }
            }
            () = tokio::time::sleep_until(deadline), if armed => {
                armed = false;
                if let Some(state) = reload(&shared) {
                    on_reload(state);
                }
            }
        }
    }
}

/// Whether an event may have changed `config.toml`'s contents. `.tmp`
/// events filter out by name; access events are reads (the window
/// fire's own included) and never arm. A watch error arms
/// conservatively — a spurious re-read is byte-compare-suppressed.
fn touches_config(event: &notify::Result<notify::Event>) -> bool {
    match event {
        Ok(event) => {
            !matches!(event.kind, notify::EventKind::Access(_))
                && event
                    .paths
                    .iter()
                    .any(|path| path.file_name().is_some_and(|name| name == "config.toml"))
        }
        Err(error) => {
            tracing::warn!(%error, "config.toml watch error");
            true
        }
    }
}

/// One window fire: read the file once and classify (ADR-0007's
/// conflict semantics). Equal bytes ⇒ self-echo, ignore. An accepted
/// external edit swaps the loaded overlay — hand-edited shared layers
/// included, so later flushes re-emit them — and resolves the full
/// cascade; the bumped epoch cuts over any pending write-back.
/// Malformed or absent contents keep last-good state (recovery is the
/// next valid write; an empty file is valid — factory state). Reload
/// never writes the file: a hand-edit stays byte-for-byte as written
/// until the next real mutation rewrites it.
fn reload(shared: &Shared) -> Option<State> {
    let mut loaded = shared.overlay.lock().expect("overlay lock");
    let bytes = match shared.file.read() {
        ReadOutcome::Clean => return None,
        ReadOutcome::Foreign(bytes) => bytes,
        ReadOutcome::Absent => {
            tracing::warn!("config.toml is gone; keeping state (the next write-back recreates it)");
            return None;
        }
        ReadOutcome::Unreadable(error) => {
            tracing::warn!(%error, "config.toml unreadable; keeping state");
            return None;
        }
    };
    let parsed = String::from_utf8(bytes)
        .map_err(|error| Error::Config(error.to_string()))
        .and_then(|document| parse_config(&document, &shared.defs, &shared.defaults));
    match parsed {
        Ok(overlay) => {
            *loaded = overlay;
            tracing::info!("config.toml edited externally; reloaded");
            Some(resolve(&shared.defaults, &loaded))
        }
        Err(error) => {
            tracing::warn!(%error, "external config.toml edit rejected; keeping last-good state");
            None
        }
    }
}
