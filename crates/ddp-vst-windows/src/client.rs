//! The plugin-client core: connect / `Hello` / ferry / dry-fallback /
//! `Goodbye` — the daemon leg of every audio block.
//!
//! Shared with the LV2 shim (Slice 21, #29): whichever slice lands
//! second extracts it into a common crate (issue #21) — hence
//! transport-generic framing over any `Read + Write` stream, with the
//! platform connect isolated in [`crate::transport`].

use std::io::{self, Read, Write};
use std::time::{Duration, Instant};

use ddp_engine::plugin::{OP_PROCESS, PluginMessage, push_pcm};
use ddp_engine::protocol::{read_message, write_message};

use crate::transport::{self, Stream};

/// The `max_frames` promised in `Hello`.
///
/// Bigger host blocks are ferried in chunks of this size, so a
/// block-size change never needs a re-`Hello`; 8192 stereo frames is a
/// 32 KiB payload, far under the protocol's 1 MiB frame bound.
pub const MAX_FRAMES: u32 = 8192;

/// How long a failed connect (or a dropped connection) suppresses the
/// next attempt: reconnects stay periodic — never a per-block retry
/// storm — while a returning daemon is picked up within a second.
pub const RETRY_INTERVAL: Duration = Duration::from_secs(1);

/// The plugin's live link to the daemon: an engine session while the
/// daemon is up, a throttled reconnect schedule while it's away.
#[derive(Debug, Default)]
pub struct DaemonLink {
    connection: Option<Connection>,
    /// When the link last went down — connects before
    /// [`RETRY_INTERVAL`] elapses are skipped.
    lost_at: Option<Instant>,
}

/// One connected session.
#[derive(Debug)]
struct Connection {
    stream: Stream,
    /// The `HelloAck`'d session id — the daemon's name for this plugin
    /// instance (diagnostic; the connection itself scopes the session).
    #[expect(dead_code, reason = "kept per issue #21; no plugin-side use yet")]
    session_id: u32,
}

impl DaemonLink {
    /// A fresh, unconnected link that connects eagerly on the first
    /// [`Self::ensure`].
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether an engine session is currently live.
    pub const fn is_connected(&self) -> bool {
        self.connection.is_some()
    }

    /// Connects and shakes hands unless already connected or inside
    /// the retry throttle — the per-block path. `Hello` is sent at
    /// `sample_rate` (sessions are rate-immutable, epic #8).
    pub fn ensure(&mut self, sample_rate: u32) {
        if self.is_connected() {
            return;
        }
        if let Some(lost_at) = self.lost_at
            && lost_at.elapsed() < RETRY_INTERVAL
        {
            return;
        }
        self.connect(sample_rate);
    }

    /// Drops any current session and connects fresh — the resume and
    /// rate-change path (rate change = `Goodbye` + fresh `Hello`).
    pub fn connect(&mut self, sample_rate: u32) {
        self.disconnect();
        let attempt = transport::connect().and_then(|mut stream| {
            let session_id = handshake(&mut stream, sample_rate)?;
            Ok(Connection { stream, session_id })
        });
        match attempt {
            Ok(connection) => self.connection = Some(connection),
            Err(_) => self.lost_at = Some(Instant::now()),
        }
    }

    /// Says `Goodbye` (best effort) and forgets the session; the retry
    /// throttle resets, so the next `ensure` connects immediately —
    /// this is the deliberate suspend/close path, not a failure.
    pub fn disconnect(&mut self) {
        if let Some(mut connection) = self.connection.take() {
            let (opcode, payload) = PluginMessage::Goodbye.encode();
            let _ = write_message(&mut connection.stream, opcode, &payload);
        }
        self.lost_at = None;
    }

    /// Ferries one interleaved PCM16 block through the daemon into
    /// `out` (chunked to the `Hello`'d [`MAX_FRAMES`]). `false` means
    /// the daemon was lost mid-block: the link is down (throttled),
    /// and the caller falls back to dry — audio never stops.
    pub fn ferry(&mut self, pcm: &[i16], out: &mut Vec<i16>) -> bool {
        let Some(connection) = &mut self.connection else {
            return false;
        };
        out.clear();
        for chunk in pcm.chunks(MAX_FRAMES as usize * 2) {
            let Ok(processed) = exchange(&mut connection.stream, chunk) else {
                // The stream is gone or desynced — either way the
                // session is unusable; drop it and retry later.
                self.connection = None;
                self.lost_at = Some(Instant::now());
                return false;
            };
            out.extend_from_slice(&processed);
        }
        true
    }
}

/// Sends `Hello` and awaits the `HelloAck`, returning the session id.
/// The daemon answers a `Hello` it won't serve (engine down, bad rate)
/// with a `Goodbye` — surfaced as [`io::ErrorKind::ConnectionRefused`].
fn handshake(stream: &mut (impl Read + Write), sample_rate: u32) -> io::Result<u32> {
    let (opcode, payload) = PluginMessage::Hello {
        sample_rate,
        max_frames: MAX_FRAMES,
    }
    .encode();
    write_message(stream, opcode, &payload)?;
    match read_daemon_message(stream)? {
        PluginMessage::HelloAck { session_id } => Ok(session_id),
        PluginMessage::Goodbye => Err(io::Error::new(
            io::ErrorKind::ConnectionRefused,
            "the daemon rejected the Hello",
        )),
        other => Err(desync(&other)),
    }
}

/// Sends one `Process` block and awaits its `Processed`, which must
/// mirror the block's length exactly — anything else is a desync.
fn exchange(stream: &mut (impl Read + Write), pcm: &[i16]) -> io::Result<Vec<i16>> {
    let frames = u32::try_from(pcm.len() / 2).expect("chunked to MAX_FRAMES");
    let mut payload = Vec::with_capacity(4 + pcm.len() * 2);
    payload.extend_from_slice(&frames.to_le_bytes());
    push_pcm(&mut payload, pcm);
    write_message(stream, OP_PROCESS, &payload)?;
    match read_daemon_message(stream)? {
        PluginMessage::Processed { pcm: processed } if processed.len() == pcm.len() => {
            Ok(processed)
        }
        other => Err(desync(&other)),
    }
}

/// Receives one framed daemon message. EOF anywhere is an error — a
/// reply was owed.
fn read_daemon_message(stream: &mut impl Read) -> io::Result<PluginMessage> {
    let (opcode, payload) = read_message(stream)?.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "the daemon closed the stream while a reply was owed",
        )
    })?;
    PluginMessage::decode(opcode, &payload)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

/// The reply wasn't what the protocol owes here (a daemon `Goodbye`
/// mid-stream lands here too — the session is over either way).
fn desync(reply: &PluginMessage) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("unexpected daemon reply: {reply:?}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scripted duplex stream: canned daemon replies on the read
    /// side, everything written captured for byte-level assertions —
    /// issue #21 behavior 1's "framing against a fake pipe".
    struct FakePipe {
        replies: io::Cursor<Vec<u8>>,
        written: Vec<u8>,
    }

    impl FakePipe {
        fn scripted(replies: &[PluginMessage]) -> Self {
            let mut wire = Vec::new();
            for reply in replies {
                let (opcode, payload) = reply.encode();
                write_message(&mut wire, opcode, &payload).unwrap();
            }
            Self {
                replies: io::Cursor::new(wire),
                written: Vec::new(),
            }
        }
    }

    impl Read for FakePipe {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.replies.read(buf)
        }
    }

    impl Write for FakePipe {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.written.extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    /// Behavior 1: the handshake puts exactly one framed
    /// `Hello {rate, MAX_FRAMES}` on the pipe — layout per epic #8 —
    /// and returns the acked session id.
    #[test]
    fn handshake_frames_a_hello_and_returns_the_acked_session() {
        let mut pipe = FakePipe::scripted(&[PluginMessage::HelloAck { session_id: 7 }]);
        assert_eq!(handshake(&mut pipe, 48_000).unwrap(), 7);
        // [u32 length = 12][u32 opcode 0x01][u32 rate][u32 max_frames]
        let expected = [
            &12_u32.to_le_bytes()[..],
            &1_u32.to_le_bytes(),
            &48_000_u32.to_le_bytes(),
            &MAX_FRAMES.to_le_bytes(),
        ]
        .concat();
        assert_eq!(pipe.written, expected);
    }

    /// Behavior 1: the daemon's in-protocol rejection (`Goodbye` for a
    /// `HelloAck`) surfaces as `ConnectionRefused`, not a panic or a
    /// bogus session.
    #[test]
    fn handshake_treats_the_daemons_goodbye_as_rejection() {
        let mut pipe = FakePipe::scripted(&[PluginMessage::Goodbye]);
        let error = handshake(&mut pipe, 96_000).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::ConnectionRefused);
    }

    /// Behavior 1: one `Process` block frames per the epic's layout and
    /// the `Processed` PCM comes back verbatim.
    #[test]
    fn exchange_frames_a_process_and_returns_the_processed_block() {
        let mut pipe = FakePipe::scripted(&[PluginMessage::Processed {
            pcm: vec![5, -5, 9, -9],
        }]);
        let processed = exchange(&mut pipe, &[1, 2, 3, 4]).unwrap();
        assert_eq!(processed, [5, -5, 9, -9]);
        // [u32 length = 4 + 4 + 8][u32 opcode 0x10][u32 frames = 2][4 × i16]
        let expected = [
            &16_u32.to_le_bytes()[..],
            &0x10_u32.to_le_bytes(),
            &2_u32.to_le_bytes(),
            &1_i16.to_le_bytes(),
            &2_i16.to_le_bytes(),
            &3_i16.to_le_bytes(),
            &4_i16.to_le_bytes(),
        ]
        .concat();
        assert_eq!(pipe.written, expected);
    }

    /// A `Processed` that doesn't mirror the block's length means the
    /// stream is desynced — error, never misaligned audio.
    #[test]
    fn exchange_rejects_a_length_mismatched_reply() {
        let mut pipe = FakePipe::scripted(&[PluginMessage::Processed { pcm: vec![5, -5] }]);
        let error = exchange(&mut pipe, &[1, 2, 3, 4]).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    /// A daemon `Goodbye` where a `Processed` was owed (it destroyed
    /// the session — e.g. the engine failed) ends the exchange in error.
    #[test]
    fn exchange_treats_a_daemon_goodbye_as_session_loss() {
        let mut pipe = FakePipe::scripted(&[PluginMessage::Goodbye]);
        assert!(exchange(&mut pipe, &[1, 2]).is_err());
    }

    /// A hangup while a reply is owed is an error — the caller drops
    /// the session and falls back to dry.
    #[test]
    fn a_hangup_mid_exchange_is_an_error() {
        let mut pipe = FakePipe::scripted(&[]);
        let error = exchange(&mut pipe, &[1, 2]).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
    }
}
