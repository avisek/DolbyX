//! *Plugin ↔ daemon* wire protocol (epic #8).
//!
//! The message shapes shared by the daemon's `AudioServer` and the
//! plugin shims — the single definition for both ends, like
//! [`crate::protocol`] is for the engine's.
//!
//! `Hello {sample_rate, max_frames}` → `HelloAck {session_id}`,
//! `Process {frames, pcm}` → `Processed {pcm}`, `Goodbye` either way.
//! Audio only — all control goes through the Web UI.
//!
//! Frames share the engine protocol's shape — `[u32 length][u32
//! opcode][payload]`, little-endian, `length` counting the opcode word
//! plus the payload — but both directions are messages (each side has
//! its own opcodes), never status replies. A shim frames them with the
//! synchronous [`crate::protocol::write_message`] /
//! [`crate::protocol::read_message`]; the daemon carries its own async
//! twins of those.

use crate::protocol::DecodeError;

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
    /// Encodes into `(opcode, payload)` for the framing writer.
    ///
    /// # Panics
    ///
    /// Never in practice: only on a PCM block past `u32::MAX` frames,
    /// orders of magnitude beyond
    /// [`MAX_FRAME_BYTES`](crate::protocol::MAX_FRAME_BYTES).
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
///
/// For building `Process`/`Processed` payloads into a reused buffer on
/// the per-block hot path, without a [`PluginMessage`] allocation.
pub fn push_pcm(payload: &mut Vec<u8>, pcm: &[i16]) {
    payload.extend(pcm.iter().flat_map(|sample| sample.to_le_bytes()));
}

/// Little-endian bytes → interleaved PCM16 samples (size pre-checked).
fn decode_pcm(bytes: &[u8]) -> Vec<i16> {
    bytes
        .chunks_exact(2)
        .map(|bytes| i16::from_le_bytes(bytes.try_into().expect("2-byte chunk")))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{read_message, write_message};

    /// Encode → frame → read → decode, for every message shape, over
    /// the synchronous framing a plugin shim uses.
    #[test]
    fn every_message_round_trips_through_the_sync_framing() {
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
            write_message(&mut wire, opcode, &payload).unwrap();
        }
        let mut reader = wire.as_slice();
        for message in &messages {
            let (opcode, payload) = read_message(&mut reader)
                .unwrap()
                .expect("one frame per message");
            assert_eq!(PluginMessage::decode(opcode, &payload), Ok(message.clone()));
        }
        assert_eq!(
            read_message(&mut reader).unwrap(),
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
}
