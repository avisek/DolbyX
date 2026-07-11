//! The shared write-back debouncer: one 500 ms window across all
//! on-disk fields; pending writes flush on graceful shutdown.

use std::path::PathBuf;
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

/// The shared debounce window (issue #12: 500 ms across all fields).
pub const DEBOUNCE: Duration = Duration::from_millis(500);

/// A message to the writer task.
pub(crate) enum Msg {
    /// Replace the pending document and (re)arm the debounce timer.
    Write(String),
    /// Write any pending document now and acknowledge.
    Flush(oneshot::Sender<()>),
}

/// Runs the writer: trailing-edge debounce, immediate flush on demand,
/// final flush when the sender side closes.
pub(crate) async fn writer(config_path: PathBuf, mut rx: mpsc::UnboundedReceiver<Msg>) {
    let mut pending: Option<String> = None;
    let mut deadline = Instant::now();
    loop {
        tokio::select! {
            msg = rx.recv() => match msg {
                Some(Msg::Write(document)) => {
                    pending = Some(document);
                    deadline = Instant::now() + DEBOUNCE;
                }
                Some(Msg::Flush(ack)) => {
                    write(&config_path, pending.take());
                    let _ = ack.send(());
                }
                None => {
                    write(&config_path, pending.take());
                    return;
                }
            },
            () = tokio::time::sleep_until(deadline), if pending.is_some() => {
                write(&config_path, pending.take());
            }
        }
    }
}

/// Writes the document, if any. Failures are logged, never fatal — the
/// daemon keeps serving from memory.
fn write(config_path: &std::path::Path, pending: Option<String>) {
    let Some(document) = pending else { return };
    if let Err(error) = std::fs::write(config_path, document) {
        tracing::error!(path = %config_path.display(), %error, "config.toml write failed");
    }
}
