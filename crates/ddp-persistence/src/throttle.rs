//! The write-back throttle: a **leading-edge** 100 ms window (issue
//! #27) — an idle mutation hits the disk immediately, a sustained drag
//! rewrites at ~10 Hz with a trailing write carrying the final value,
//! and pending writes flush on graceful shutdown.

use std::sync::Arc;

use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use crate::{SyncedFile, WINDOW, WriteOutcome};

/// A message to the writer task.
pub(crate) enum Msg {
    /// Write this document, throttled. The epoch is the reload count
    /// [`SyncedFile`] held when the document was serialized — a reload
    /// since makes it stale, and the write aborts (the file is truth).
    Write(String, u64),
    /// Write any pending document now and acknowledge.
    Flush(oneshot::Sender<()>),
}

/// Runs the writer: leading-edge throttle over [`WINDOW`], immediate
/// flush on demand, final flush when the sender side closes.
pub(crate) async fn writer(file: Arc<SyncedFile>, mut rx: mpsc::UnboundedReceiver<Msg>) {
    // `next_allowed` starts in the past, so the first write is leading.
    let mut next_allowed = Instant::now();
    let mut pending: Option<(String, u64)> = None;
    loop {
        tokio::select! {
            msg = rx.recv() => match msg {
                Some(Msg::Write(document, epoch)) => {
                    if Instant::now() >= next_allowed {
                        // A newer document supersedes any pending one.
                        pending = write(&file, document, epoch, &mut next_allowed);
                    } else {
                        pending = Some((document, epoch));
                    }
                }
                Some(Msg::Flush(ack)) => {
                    if let Some((document, epoch)) = pending.take() {
                        pending = write(&file, document, epoch, &mut next_allowed);
                    }
                    let _ = ack.send(());
                }
                None => {
                    if let Some((document, epoch)) = pending.take() {
                        write(&file, document, epoch, &mut next_allowed);
                    }
                    return;
                }
            },
            () = tokio::time::sleep_until(next_allowed), if pending.is_some() => {
                let (document, epoch) = pending.take().expect("guarded by the select arm");
                pending = write(&file, document, epoch, &mut next_allowed);
            }
        }
    }
}

/// One write attempt; the window re-arms either way — at most one disk
/// touch per [`WINDOW`]. [`SyncedFile`] may refuse it: a stale epoch
/// drops the document for good (an accepted reload cut it over), an
/// uningested hand-edit defers it — handed back as the pending write,
/// retried next window (by then the watcher has ingested: accepted ⇒
/// the retry goes stale, rejected ⇒ it lands, overwriting the broken
/// file — last-writer-wins).
fn write(
    file: &SyncedFile,
    document: String,
    epoch: u64,
    next_allowed: &mut Instant,
) -> Option<(String, u64)> {
    let outcome = file.write(&document, epoch);
    *next_allowed = Instant::now() + WINDOW;
    match outcome {
        WriteOutcome::Written | WriteOutcome::Stale => None,
        WriteOutcome::Foreign => Some((document, epoch)),
    }
}
