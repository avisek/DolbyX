//! `AudioServer` — the daemon side of the *Plugin ↔ daemon* protocol.
//!
//! Epic #8: `Hello {sample_rate, max_frames}` → `HelloAck
//! {session_id}`, `Process {frames, pcm}` → `Processed {pcm}`,
//! `Goodbye` either way. Audio only — all control goes through the Web
//! UI.
//!
//! Frames share the engine protocol's shape — `[u32 length][u32
//! opcode][payload]`, little-endian, `length` counting the opcode word
//! plus the payload — but both directions are messages (each side has
//! its own opcodes), never status replies. Protocol handling is
//! transport-agnostic over any duplex byte stream; the per-platform
//! accept happens in [`crate::platform`] (named pipe / `AF_UNIX` — two
//! adapters, a real seam).
//!
//! A plugin's `Hello` creates its engine session (host-side rate
//! validation applies — a bad rate is rejected with a `Goodbye`); its
//! `Goodbye` or disconnect destroys it. The daemon never creates
//! sessions on its own. Audio stays int16 stereo end-to-end here; the
//! plugin converts from float32 once at the host boundary.

use std::convert::Infallible;
use std::sync::Arc;

use ddp_engine::SessionId;
use ddp_engine::protocol::{DecodeError, MAX_FRAME_BYTES};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::App;
use crate::platform::PluginListener;

/// Opcode of [`PluginMessage::Hello`].
pub const OP_HELLO: u32 = 0x01;
/// Opcode of [`PluginMessage::HelloAck`].
pub const OP_HELLO_ACK: u32 = 0x02;
/// Opcode of [`PluginMessage::Process`].
pub const OP_PROCESS: u32 = 0x10;
/// Opcode of [`PluginMessage::Processed`].
pub const OP_PROCESSED: u32 = 0x11;
/// Opcode of [`PluginMessage::Goodbye`].
pub const OP_GOODBYE: u32 = 0x20;

/// One plugin-protocol message, either direction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PluginMessage {
    /// 0x01, plugin → daemon: `[u32 sample_rate][u32 max_frames]` —
    /// the handshake; creates the plugin's engine session.
    Hello {
        /// The session's fixed sample rate.
        sample_rate: u32,
        /// The largest block the plugin will ever `Process` — nonzero.
        max_frames: u32,
    },
    /// 0x02, daemon → plugin: `[u32 session_id]` — the created
    /// session's stable id.
    HelloAck {
        /// The supervisor's external session id.
        session_id: u32,
    },
    /// 0x10, plugin → daemon: `[u32 frames][i16 × frames × 2 pcm]` —
    /// one interleaved-stereo PCM16 block.
    Process {
        /// Interleaved stereo samples, `frames × 2` of them.
        pcm: Vec<i16>,
    },
    /// 0x11, daemon → plugin: `[i16 × frames × 2 pcm]` — the processed
    /// block, mirroring the `Process` it answers.
    Processed {
        /// Interleaved stereo samples, `frames × 2` of them.
        pcm: Vec<i16>,
    },
    /// 0x20, either way: empty — the clean close (and the daemon's
    /// rejection of a bad `Hello`).
    Goodbye,
}

impl PluginMessage {
    /// Encodes into `(opcode, payload)` for [`write_plugin_message`].
    ///
    /// # Panics
    ///
    /// Never in practice: only on a PCM block past `u32::MAX` frames,
    /// orders of magnitude beyond [`MAX_FRAME_BYTES`].
    #[must_use]
    pub fn encode(&self) -> (u32, Vec<u8>) {
        match *self {
            Self::Hello {
                sample_rate,
                max_frames,
            } => {
                let mut payload = sample_rate.to_le_bytes().to_vec();
                payload.extend_from_slice(&max_frames.to_le_bytes());
                (OP_HELLO, payload)
            }
            Self::HelloAck { session_id } => (OP_HELLO_ACK, session_id.to_le_bytes().to_vec()),
            Self::Process { ref pcm } => {
                let frames = u32::try_from(pcm.len() / 2).expect("bounded by MAX_FRAME_BYTES");
                let mut payload = Vec::with_capacity(4 + pcm.len() * 2);
                payload.extend_from_slice(&frames.to_le_bytes());
                push_pcm(&mut payload, pcm);
                (OP_PROCESS, payload)
            }
            Self::Processed { ref pcm } => {
                let mut payload = Vec::with_capacity(pcm.len() * 2);
                push_pcm(&mut payload, pcm);
                (OP_PROCESSED, payload)
            }
            Self::Goodbye => (OP_GOODBYE, Vec::new()),
        }
    }

    /// Decodes a received `(opcode, payload)` message.
    ///
    /// # Errors
    ///
    /// [`DecodeError`] on an unknown opcode or a payload that doesn't
    /// fit its layout.
    pub fn decode(opcode: u32, payload: &[u8]) -> Result<Self, DecodeError> {
        let malformed = |context| Err(DecodeError::MalformedPayload(opcode, context));
        match opcode {
            OP_HELLO => match (payload.first_chunk(), payload.last_chunk()) {
                (Some(rate), Some(frames)) if payload.len() == 8 => Ok(Self::Hello {
                    sample_rate: u32::from_le_bytes(*rate),
                    max_frames: u32::from_le_bytes(*frames),
                }),
                _ => malformed("payload is not [u32 sample_rate][u32 max_frames]"),
            },
            OP_HELLO_ACK => match payload.first_chunk() {
                Some(id) if payload.len() == 4 => Ok(Self::HelloAck {
                    session_id: u32::from_le_bytes(*id),
                }),
                _ => malformed("payload is not a u32 session_id"),
            },
            OP_PROCESS => {
                let Some((frames, pcm)) = payload.split_first_chunk() else {
                    return malformed("frame count");
                };
                let frames = u32::from_le_bytes(*frames);
                if frames == 0 {
                    return malformed("zero frames");
                }
                // u64: `frames × 4` must not wrap on 32-bit targets.
                if pcm.len() as u64 != u64::from(frames) * 4 {
                    return malformed("payload size doesn't match the frame count");
                }
                Ok(Self::Process {
                    pcm: decode_pcm(pcm),
                })
            }
            OP_PROCESSED => {
                if payload.is_empty() || !payload.len().is_multiple_of(4) {
                    return malformed("payload is not whole interleaved-stereo PCM16 frames");
                }
                Ok(Self::Processed {
                    pcm: decode_pcm(payload),
                })
            }
            OP_GOODBYE => {
                if payload.is_empty() {
                    Ok(Self::Goodbye)
                } else {
                    malformed("Goodbye carries no payload")
                }
            }
            _ => Err(DecodeError::UnknownOpcode(opcode)),
        }
    }
}

/// Appends interleaved PCM16 samples as their little-endian wire bytes.
fn push_pcm(payload: &mut Vec<u8>, pcm: &[i16]) {
    payload.extend(pcm.iter().flat_map(|sample| sample.to_le_bytes()));
}

/// Little-endian bytes → interleaved PCM16 samples (size pre-checked).
fn decode_pcm(bytes: &[u8]) -> Vec<i16> {
    bytes
        .chunks_exact(2)
        .map(|bytes| i16::from_le_bytes(bytes.try_into().expect("2-byte chunk")))
        .collect()
}

/// Serves plugin connections forever: accept → one task per plugin.
/// Bind failures were already handled at startup; an accept failure is
/// transient (log, breathe, keep serving).
pub(crate) async fn accept_loop(mut listener: PluginListener, app: Arc<App>) -> Infallible {
    loop {
        match listener.accept().await {
            Ok(stream) => {
                tokio::spawn(serve_plugin(stream, app.clone()));
            }
            Err(error) => {
                tracing::warn!(%error, "plugin accept failed");
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        }
    }
}

/// Serves one plugin over any duplex byte stream — the
/// transport-agnostic half both platform adapters feed.
///
/// `Hello` creates the plugin's session (a rejected rate answers
/// `Goodbye` and closes — the daemon stays healthy); `Goodbye` or
/// disconnect destroys it, however the connection ends.
async fn serve_plugin<S: AsyncRead + AsyncWrite + Unpin>(mut stream: S, app: Arc<App>) {
    let hello = match read_plugin_message(&mut stream).await {
        Ok(Some((opcode, payload))) => PluginMessage::decode(opcode, &payload),
        // Gone before the handshake — nothing was created.
        Ok(None) | Err(_) => return,
    };
    let Ok(PluginMessage::Hello {
        sample_rate,
        max_frames,
    }) = hello
    else {
        tracing::warn!("plugin handshake was not a Hello");
        let _ = send(&mut stream, &PluginMessage::Goodbye).await;
        return;
    };
    if max_frames == 0 {
        tracing::warn!("plugin Hello promised zero max_frames");
        let _ = send(&mut stream, &PluginMessage::Goodbye).await;
        return;
    }
    // Host-side validation (Slice 08) rejects engine-footgun rates
    // inside `create_session` — the engine never sees a bad rate.
    let created = with_main_watch(&app, || app.supervisor.create_session(sample_rate)).await;
    let session = match created {
        Ok(session) => session,
        Err(error) => {
            tracing::warn!(%error, sample_rate, "plugin Hello rejected");
            let _ = send(&mut stream, &PluginMessage::Goodbye).await;
            return;
        }
    };
    tracing::info!(
        session = session.0,
        sample_rate,
        max_frames,
        "plugin connected"
    );
    if send(
        &mut stream,
        &PluginMessage::HelloAck {
            session_id: session.0,
        },
    )
    .await
    .is_ok()
    {
        pump(&mut stream, &app, session, max_frames).await;
    }
    if let Err(error) = with_main_watch(&app, || app.supervisor.destroy_session(session)).await {
        tracing::warn!(%error, session = session.0, "session teardown failed");
    }
    tracing::info!(session = session.0, "plugin disconnected");
}

/// Answers `Process` blocks until the plugin says `Goodbye`,
/// disconnects, or breaks protocol (answered by a `Goodbye` and the
/// session's end — the daemon never limps along on a desynced stream).
async fn pump<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    app: &App,
    session: SessionId,
    max_frames: u32,
) {
    let mut output = Vec::new();
    let mut reply = Vec::new();
    loop {
        let message = match read_plugin_message(stream).await {
            Ok(Some((opcode, payload))) => PluginMessage::decode(opcode, &payload),
            // Abrupt disconnect — same cleanup as a Goodbye.
            Ok(None) | Err(_) => return,
        };
        match message {
            Ok(PluginMessage::Process { pcm }) if pcm.len() as u64 <= u64::from(max_frames) * 2 => {
                output.resize(pcm.len(), 0);
                match app.supervisor.process(session, &pcm, &mut output) {
                    // The vis tail feeds the `vis` event stream in
                    // Slice 16 (#24); here the plugin only needs PCM.
                    Ok(_vis) => {
                        reply.clear();
                        push_pcm(&mut reply, &output);
                        if write_plugin_message(stream, OP_PROCESSED, &reply)
                            .await
                            .is_err()
                        {
                            return;
                        }
                    }
                    Err(error) => {
                        tracing::error!(%error, session = session.0, "process failed");
                        let _ = send(stream, &PluginMessage::Goodbye).await;
                        return;
                    }
                }
            }
            Ok(PluginMessage::Goodbye) => return,
            Ok(message) => {
                tracing::warn!(
                    session = session.0,
                    ?message,
                    "plugin protocol violation (oversized block, re-Hello, or a daemon-only message)"
                );
                let _ = send(stream, &PluginMessage::Goodbye).await;
                return;
            }
            Err(error) => {
                tracing::warn!(session = session.0, %error, "undecodable plugin message");
                let _ = send(stream, &PluginMessage::Goodbye).await;
                return;
            }
        }
    }
}

/// Sends one message.
async fn send(
    stream: &mut (impl AsyncWrite + Unpin),
    message: &PluginMessage,
) -> std::io::Result<()> {
    let (opcode, payload) = message.encode();
    write_plugin_message(stream, opcode, &payload).await
}

/// Runs one session-table mutation, broadcasting a fresh snapshot when
/// the main session changed under it — a first session fills the
/// `readouts`, a handover re-reads them, the last death clears them
/// back to defaults.
async fn with_main_watch<T>(app: &App, mutation: impl FnOnce() -> T) -> T {
    let before = app.supervisor.main_session();
    let result = mutation();
    if app.supervisor.main_session() != before {
        app.broadcast_snapshot().await;
    }
    result
}

/// Sends one framed plugin-protocol message.
///
/// # Errors
///
/// [`std::io::ErrorKind::InvalidInput`] when `payload` exceeds
/// [`MAX_FRAME_BYTES`]; otherwise the underlying stream's error.
pub async fn write_plugin_message(
    writer: &mut (impl AsyncWrite + Unpin),
    opcode: u32,
    payload: &[u8],
) -> std::io::Result<()> {
    let length = u32::try_from(payload.len())
        .ok()
        .and_then(|len| len.checked_add(4))
        .filter(|&len| len <= MAX_FRAME_BYTES)
        .ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "frame payload too large")
        })?;
    // One buffer, one write: a frame never interleaves with another.
    let mut frame = Vec::with_capacity(8 + payload.len());
    frame.extend_from_slice(&length.to_le_bytes());
    frame.extend_from_slice(&opcode.to_le_bytes());
    frame.extend_from_slice(payload);
    writer.write_all(&frame).await
}

/// Receives one framed plugin-protocol message. `Ok(None)` on clean
/// EOF — the peer closed the stream between frames.
///
/// # Errors
///
/// [`std::io::ErrorKind::InvalidData`] on a length prefix below 4 or
/// above [`MAX_FRAME_BYTES`]; [`std::io::ErrorKind::UnexpectedEof`] on
/// a stream truncated mid-frame.
pub async fn read_plugin_message(
    reader: &mut (impl AsyncRead + Unpin),
) -> std::io::Result<Option<(u32, Vec<u8>)>> {
    // A clean EOF is only one that lands *between* frames: zero bytes
    // of the next length prefix. EOF after a partial prefix is
    // truncation.
    let mut length = [0_u8; 4];
    let mut filled = 0;
    while filled < length.len() {
        match reader.read(&mut length[filled..]).await? {
            0 if filled == 0 => return Ok(None),
            0 => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "stream truncated inside a frame's length prefix",
                ));
            }
            n => filled += n,
        }
    }
    let length = u32::from_le_bytes(length);
    if !(4..=MAX_FRAME_BYTES).contains(&length) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("frame length {length} outside 4..={MAX_FRAME_BYTES}"),
        ));
    }
    let mut opcode = [0_u8; 4];
    reader.read_exact(&mut opcode).await?;
    let mut payload = vec![0_u8; length as usize - 4];
    reader.read_exact(&mut payload).await?;
    Ok(Some((u32::from_le_bytes(opcode), payload)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Encode → frame → read → decode, for every message shape — the
    /// codec both ends of the plugin protocol share.
    #[tokio::test]
    async fn every_message_round_trips_through_the_framing() {
        let messages = [
            PluginMessage::Hello {
                sample_rate: 48_000,
                max_frames: 512,
            },
            PluginMessage::HelloAck { session_id: 7 },
            PluginMessage::Process {
                pcm: vec![0, -1, 32767, -32768],
            },
            PluginMessage::Processed {
                pcm: vec![5, -5, 9, -9],
            },
            PluginMessage::Goodbye,
        ];
        let mut wire = Vec::new();
        for message in &messages {
            let (opcode, payload) = message.encode();
            write_plugin_message(&mut wire, opcode, &payload)
                .await
                .unwrap();
        }
        let mut reader = wire.as_slice();
        for message in &messages {
            let (opcode, payload) = read_plugin_message(&mut reader)
                .await
                .unwrap()
                .expect("one frame per message");
            assert_eq!(PluginMessage::decode(opcode, &payload), Ok(message.clone()));
        }
        assert_eq!(
            read_plugin_message(&mut reader).await.unwrap(),
            None,
            "EOF between frames is clean"
        );
    }

    #[test]
    fn hello_and_ack_reject_bad_sizes() {
        let (opcode, payload) = PluginMessage::Hello {
            sample_rate: 48_000,
            max_frames: 512,
        }
        .encode();
        assert_eq!(opcode, OP_HELLO);
        assert_eq!(payload.len(), 8);
        assert!(
            PluginMessage::decode(opcode, &payload[..7]).is_err(),
            "short"
        );
        assert!(
            PluginMessage::decode(opcode, &[payload, vec![0]].concat()).is_err(),
            "trailing bytes mean the stream is desynced"
        );

        let (opcode, payload) = PluginMessage::HelloAck { session_id: 7 }.encode();
        assert_eq!(opcode, OP_HELLO_ACK);
        assert!(
            PluginMessage::decode(opcode, &payload[..3]).is_err(),
            "short"
        );
        assert!(PluginMessage::decode(opcode, &[payload, vec![0]].concat()).is_err());
    }

    #[test]
    fn process_rejects_inconsistent_frame_counts() {
        let (opcode, mut payload) = PluginMessage::Process {
            pcm: vec![1, 2, 3, 4],
        }
        .encode();
        assert_eq!(opcode, OP_PROCESS);
        // [u32 frames][i16 × frames × 2]: 2 frames of stereo.
        assert_eq!(payload[..4], 2_u32.to_le_bytes());
        // Claim 3 frames while carrying 2 frames' worth of samples.
        payload[..4].copy_from_slice(&3_u32.to_le_bytes());
        assert!(PluginMessage::decode(opcode, &payload).is_err());
        // Zero frames is meaningless — reject rather than poke the engine.
        let zero = 0_u32.to_le_bytes();
        assert!(PluginMessage::decode(opcode, &zero).is_err());
    }

    #[test]
    fn processed_must_be_whole_stereo_frames() {
        // 6 bytes = 3 samples: mono-shaped, not whole stereo frames.
        assert!(PluginMessage::decode(OP_PROCESSED, &[0; 6]).is_err());
        assert!(PluginMessage::decode(OP_PROCESSED, &[]).is_err(), "empty");
        assert_eq!(
            PluginMessage::decode(OP_PROCESSED, &[1, 0, 2, 0]),
            Ok(PluginMessage::Processed { pcm: vec![1, 2] })
        );
    }

    #[test]
    fn goodbye_is_empty_and_unknown_opcodes_are_rejected() {
        assert_eq!(
            PluginMessage::decode(OP_GOODBYE, &[]),
            Ok(PluginMessage::Goodbye)
        );
        assert!(PluginMessage::decode(OP_GOODBYE, &[0]).is_err());
        assert_eq!(
            PluginMessage::decode(0x99, &[]),
            Err(DecodeError::UnknownOpcode(0x99))
        );
    }

    #[tokio::test]
    async fn corrupt_length_prefixes_and_truncation_are_rejected() {
        for bad_length in [0_u32, 3, MAX_FRAME_BYTES + 1] {
            let mut wire = bad_length.to_le_bytes().to_vec();
            wire.extend_from_slice(&[0; 8]);
            let error = read_plugin_message(&mut wire.as_slice()).await.unwrap_err();
            assert_eq!(
                error.kind(),
                std::io::ErrorKind::InvalidData,
                "{bad_length}"
            );
        }

        let mut wire = Vec::new();
        write_plugin_message(&mut wire, OP_HELLO, &[0; 8])
            .await
            .unwrap();
        for cut in 1..wire.len() {
            let error = read_plugin_message(&mut &wire[..cut]).await.unwrap_err();
            assert_eq!(
                error.kind(),
                std::io::ErrorKind::UnexpectedEof,
                "cut at {cut}"
            );
        }

        let oversized = vec![0_u8; MAX_FRAME_BYTES as usize];
        let error = write_plugin_message(&mut Vec::new(), OP_PROCESS, &oversized)
            .await
            .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
    }
}
