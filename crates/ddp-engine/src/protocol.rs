//! Daemon ↔ engine-shim wire protocol (epic #8): length-prefixed
//! little-endian frames over the subprocess's stdin/stdout.
//!
//! Single definition shared by both ends — the daemon side
//! (`QemuBackend`, Slice 08 [#16](https://github.com/avisek/DolbyX/issues/16))
//! encodes commands and decodes replies; the `ddp-engine-arm` shim does
//! the reverse. Message `[u32 length][u32 opcode][payload]`, reply
//! `[u32 length][i32 status][payload]`; `length` counts the opcode /
//! status word plus the payload.
//!
//! ```
//! use ddp_engine::protocol::{Command, read_message, write_message};
//!
//! let command = Command::CreateSession { sample_rate: 48_000 };
//! let (opcode, payload) = command.encode();
//! let mut wire = Vec::new();
//! write_message(&mut wire, opcode, &payload)?;
//!
//! let (opcode, payload) = read_message(&mut wire.as_slice())?.expect("one frame");
//! assert_eq!(Command::decode(opcode, &payload), Ok(command));
//! # Ok::<(), std::io::Error>(())
//! ```

use std::io::{self, Read, Write};

/// Largest accepted `length` prefix — bounds one frame's allocation
/// (a 1 MiB frame holds a quarter-million stereo PCM16 frames, far past
/// any real audio block).
pub const MAX_FRAME_BYTES: u32 = 1024 * 1024;

/// Success status — every other value is an error.
pub const STATUS_OK: i32 = 0;
/// The message was malformed or named an unsupported value — the shim
/// never forwarded it to the engine (mirrors `-EINVAL`). Statuses
/// other than these three are the engine's own, forwarded verbatim.
pub const STATUS_INVALID: i32 = -22;
/// The session id names no live session (mirrors `-ENOENT`).
pub const STATUS_NO_SESSION: i32 = -2;

/// Sends one framed reply (shim → daemon).
///
/// # Errors
///
/// [`io::ErrorKind::InvalidInput`] when `payload` exceeds
/// [`MAX_FRAME_BYTES`]; otherwise the underlying writer's error.
pub fn write_reply(writer: &mut impl Write, status: i32, payload: &[u8]) -> io::Result<()> {
    write_frame(writer, status.to_le_bytes(), payload)
}

/// Receives one framed reply (daemon side). A reply is always owed —
/// EOF here means the shim died, so it is an error, never `None`.
///
/// # Errors
///
/// [`io::ErrorKind::UnexpectedEof`] when the shim closed the stream;
/// [`io::ErrorKind::InvalidData`] on a corrupt length prefix.
pub fn read_reply(reader: &mut impl Read) -> io::Result<(i32, Vec<u8>)> {
    read_frame(reader)?
        .map(|(word, payload)| (i32::from_le_bytes(word), payload))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "engine shim closed the stream while a reply was owed",
            )
        })
}

/// Sends one framed message (daemon → shim).
///
/// # Errors
///
/// [`io::ErrorKind::InvalidInput`] when `payload` exceeds
/// [`MAX_FRAME_BYTES`]; otherwise the underlying writer's error.
pub fn write_message(writer: &mut impl Write, opcode: u32, payload: &[u8]) -> io::Result<()> {
    write_frame(writer, opcode.to_le_bytes(), payload)
}

/// Receives one framed message (shim side). `Ok(None)` on clean EOF —
/// the peer closed the stream between frames.
///
/// # Errors
///
/// [`io::ErrorKind::InvalidData`] on a length prefix below 4 or above
/// [`MAX_FRAME_BYTES`]; [`io::ErrorKind::UnexpectedEof`] on a stream
/// truncated mid-frame.
pub fn read_message(reader: &mut impl Read) -> io::Result<Option<(u32, Vec<u8>)>> {
    Ok(read_frame(reader)?.map(|(word, payload)| (u32::from_le_bytes(word), payload)))
}

/// Frames `word ‖ payload` behind its length prefix — the message and
/// reply layouts differ only in what the leading word means.
fn write_frame(writer: &mut impl Write, word: [u8; 4], payload: &[u8]) -> io::Result<()> {
    let length = u32::try_from(payload.len())
        .ok()
        .and_then(|len| len.checked_add(4))
        .filter(|&len| len <= MAX_FRAME_BYTES)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "frame payload too large"))?;
    writer.write_all(&length.to_le_bytes())?;
    writer.write_all(&word)?;
    writer.write_all(payload)
}

/// Reads one length-prefixed frame; `None` on EOF before any byte.
fn read_frame(reader: &mut impl Read) -> io::Result<Option<([u8; 4], Vec<u8>)>> {
    // A clean EOF is only one that lands *between* frames: zero bytes of
    // the next length prefix. EOF after a partial prefix is truncation.
    let mut length = [0_u8; 4];
    let mut filled = 0;
    while filled < length.len() {
        match reader.read(&mut length[filled..]) {
            Ok(0) if filled == 0 => return Ok(None),
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "stream truncated inside a frame's length prefix",
                ));
            }
            Ok(n) => filled += n,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    let length = u32::from_le_bytes(length);
    if !(4..=MAX_FRAME_BYTES).contains(&length) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("frame length {length} outside 4..={MAX_FRAME_BYTES}"),
        ));
    }
    let mut word = [0_u8; 4];
    reader.read_exact(&mut word)?;
    let mut payload = vec![0_u8; length as usize - 4];
    reader.read_exact(&mut payload)?;
    Ok(Some((word, payload)))
}

/// Opcode of [`Command::CreateSession`].
pub const OP_CREATE_SESSION: u32 = 0x01;
/// Opcode of [`Command::DestroySession`].
pub const OP_DESTROY_SESSION: u32 = 0x02;
/// Opcode of [`Command::SetEnabled`].
pub const OP_SET_ENABLED: u32 = 0x03;
/// Opcode of [`Command::Process`].
pub const OP_PROCESS: u32 = 0x30;

/// Why a received message failed to decode into a [`Command`].
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DecodeError {
    /// The opcode names no known command.
    #[error("unknown opcode {0:#x}")]
    UnknownOpcode(u32),
    /// The payload doesn't fit the opcode's layout.
    #[error("malformed {0:#x} payload: {1}")]
    MalformedPayload(u32, &'static str),
}

/// A decoded daemon → shim command. Ops 0x01–0x03 + 0x30 (this slice);
/// `SetParams` 0x10 / `GetParams` 0x11 land in Slice 07
/// ([#15](https://github.com/avisek/DolbyX/issues/15)).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    /// 0x01 `[u32 sample_rate]` → reply `[u32 session_id]`.
    CreateSession {
        /// The session's fixed sample rate.
        sample_rate: u32,
    },
    /// 0x02 `[u32 session_id]` → empty reply.
    DestroySession {
        /// The session to release.
        session_id: u32,
    },
    /// 0x03 `[u32 session_id][u8 enabled]` → empty reply.
    SetEnabled {
        /// The session to enable or disable.
        session_id: u32,
        /// `true` → `EFFECT_CMD_ENABLE`, `false` → `EFFECT_CMD_DISABLE`.
        enabled: bool,
    },
    /// 0x30 `[u32 session_id][u32 frames][i16 × frames × 2]` → reply
    /// `[i16 × frames × 2 pcm]` (+ the 160-byte vis tail from Slice 07
    /// on — the PCM block always comes first).
    Process {
        /// The session that processes the block.
        session_id: u32,
        /// Interleaved stereo PCM16, `frames × 2` samples.
        pcm: Vec<i16>,
    },
}

impl Command {
    /// Encodes into `(opcode, payload)` for [`write_message`].
    ///
    /// # Panics
    ///
    /// Never in practice: only on a PCM block past `u32::MAX` frames,
    /// orders of magnitude beyond [`MAX_FRAME_BYTES`].
    #[must_use]
    pub fn encode(&self) -> (u32, Vec<u8>) {
        match *self {
            Self::CreateSession { sample_rate } => {
                (OP_CREATE_SESSION, sample_rate.to_le_bytes().to_vec())
            }
            Self::DestroySession { session_id } => {
                (OP_DESTROY_SESSION, session_id.to_le_bytes().to_vec())
            }
            Self::SetEnabled {
                session_id,
                enabled,
            } => {
                let mut payload = session_id.to_le_bytes().to_vec();
                payload.push(u8::from(enabled));
                (OP_SET_ENABLED, payload)
            }
            Self::Process {
                session_id,
                ref pcm,
            } => {
                let frames = u32::try_from(pcm.len() / 2).expect("bounded by MAX_FRAME_BYTES");
                let mut payload = Vec::with_capacity(8 + pcm.len() * 2);
                payload.extend_from_slice(&session_id.to_le_bytes());
                payload.extend_from_slice(&frames.to_le_bytes());
                payload.extend(pcm.iter().flat_map(|sample| sample.to_le_bytes()));
                (OP_PROCESS, payload)
            }
        }
    }

    /// Decodes a received `(opcode, payload)` message.
    ///
    /// # Errors
    ///
    /// [`DecodeError`] on an unknown opcode or a payload that doesn't
    /// fit its layout.
    ///
    /// # Panics
    ///
    /// Never in practice: the PCM split is over a size-checked payload.
    pub fn decode(opcode: u32, payload: &[u8]) -> Result<Self, DecodeError> {
        match opcode {
            OP_CREATE_SESSION => {
                exact_len(opcode, payload, 4)?;
                Ok(Self::CreateSession {
                    sample_rate: field_u32(opcode, payload, 0, "sample_rate")?,
                })
            }
            OP_DESTROY_SESSION => {
                exact_len(opcode, payload, 4)?;
                Ok(Self::DestroySession {
                    session_id: field_u32(opcode, payload, 0, "session_id")?,
                })
            }
            OP_SET_ENABLED => {
                exact_len(opcode, payload, 5)?;
                Ok(Self::SetEnabled {
                    session_id: field_u32(opcode, payload, 0, "session_id")?,
                    enabled: match payload[4] {
                        0 => false,
                        1 => true,
                        _ => {
                            return Err(DecodeError::MalformedPayload(
                                opcode,
                                "enabled byte must be 0 or 1",
                            ));
                        }
                    },
                })
            }
            OP_PROCESS => {
                let session_id = field_u32(opcode, payload, 0, "session_id")?;
                let frames = field_u32(opcode, payload, 4, "frames")?;
                if frames == 0 {
                    return Err(DecodeError::MalformedPayload(opcode, "zero frames"));
                }
                // u64: `frames × 4` must not wrap on 32-bit ARM.
                if payload.len() as u64 != 8 + u64::from(frames) * 4 {
                    return Err(DecodeError::MalformedPayload(
                        opcode,
                        "payload size doesn't match the frame count",
                    ));
                }
                let pcm = payload[8..]
                    .chunks_exact(2)
                    .map(|bytes| i16::from_le_bytes(bytes.try_into().expect("2-byte chunk")))
                    .collect();
                Ok(Self::Process { session_id, pcm })
            }
            _ => Err(DecodeError::UnknownOpcode(opcode)),
        }
    }
}

/// Rejects payloads that aren't exactly `expected` bytes — a size
/// mismatch means the peer and this end disagree on the layout.
fn exact_len(opcode: u32, payload: &[u8], expected: usize) -> Result<(), DecodeError> {
    if payload.len() == expected {
        Ok(())
    } else {
        Err(DecodeError::MalformedPayload(
            opcode,
            "payload size doesn't match the opcode's layout",
        ))
    }
}

/// Reads the little-endian `u32` at `offset`, named for error messages.
fn field_u32(
    opcode: u32,
    payload: &[u8],
    offset: usize,
    name: &'static str,
) -> Result<u32, DecodeError> {
    payload
        .get(offset..offset + 4)
        .map(|bytes| u32::from_le_bytes(bytes.try_into().expect("4-byte slice")))
        .ok_or(DecodeError::MalformedPayload(opcode, name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reply_frames_round_trip() {
        let mut wire = Vec::new();
        write_reply(&mut wire, STATUS_OK, &[9, 8]).unwrap();
        write_reply(&mut wire, -22, &[]).unwrap();
        let mut reader = wire.as_slice();
        assert_eq!(read_reply(&mut reader).unwrap(), (STATUS_OK, vec![9, 8]));
        assert_eq!(read_reply(&mut reader).unwrap(), (-22, vec![]));
    }

    #[test]
    fn message_frames_round_trip() {
        let mut wire = Vec::new();
        write_message(&mut wire, 0x30, &[1, 2, 3]).unwrap();
        write_message(&mut wire, 0x02, &[]).unwrap();
        let mut reader = wire.as_slice();
        assert_eq!(
            read_message(&mut reader).unwrap(),
            Some((0x30, vec![1, 2, 3]))
        );
        assert_eq!(read_message(&mut reader).unwrap(), Some((0x02, vec![])));
    }

    #[test]
    fn eof_between_frames_is_clean_but_truncation_is_not() {
        assert_eq!(read_message(&mut [].as_slice()).unwrap(), None);

        let mut wire = Vec::new();
        write_message(&mut wire, 0x01, &[0; 8]).unwrap();
        for cut in 1..wire.len() {
            let error = read_message(&mut &wire[..cut]).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof, "cut at {cut}");
        }
    }

    #[test]
    fn create_session_round_trips_and_rejects_bad_sizes() {
        let command = Command::CreateSession {
            sample_rate: 48_000,
        };
        let (opcode, payload) = command.encode();
        assert_eq!(opcode, OP_CREATE_SESSION);
        assert_eq!(Command::decode(opcode, &payload), Ok(command));
        assert!(Command::decode(opcode, &payload[..3]).is_err(), "short");
        assert!(
            Command::decode(opcode, &[payload, vec![0]].concat()).is_err(),
            "trailing bytes mean the stream is desynced"
        );
    }

    #[test]
    fn destroy_and_set_enabled_round_trip_with_strict_payloads() {
        let destroy = Command::DestroySession { session_id: 7 };
        let (opcode, payload) = destroy.encode();
        assert_eq!(opcode, OP_DESTROY_SESSION);
        assert_eq!(Command::decode(opcode, &payload), Ok(destroy));

        for enabled in [false, true] {
            let command = Command::SetEnabled {
                session_id: 7,
                enabled,
            };
            let (opcode, payload) = command.encode();
            assert_eq!(opcode, OP_SET_ENABLED);
            assert_eq!(payload.len(), 5);
            assert_eq!(Command::decode(opcode, &payload), Ok(command));
        }
        // Only 0/1 are valid enabled bytes — anything else is desync.
        let garbage = Command::decode(OP_SET_ENABLED, &[7, 0, 0, 0, 2]);
        assert!(garbage.is_err());
    }

    #[test]
    fn process_round_trips_interleaved_stereo_pcm() {
        let command = Command::Process {
            session_id: 3,
            pcm: vec![0, -1, 32767, -32768, 5, -5],
        };
        let (opcode, payload) = command.encode();
        assert_eq!(opcode, OP_PROCESS);
        // [u32 id][u32 frames][i16 × frames × 2]: 3 frames of stereo.
        assert_eq!(payload[4..8], 3_u32.to_le_bytes());
        assert_eq!(payload.len(), 8 + 6 * 2);
        assert_eq!(Command::decode(opcode, &payload), Ok(command));
    }

    #[test]
    fn process_rejects_inconsistent_frame_counts() {
        let (_, mut payload) = Command::Process {
            session_id: 3,
            pcm: vec![1, 2, 3, 4],
        }
        .encode();
        // Claim 3 frames while carrying 2 frames' worth of samples.
        payload[4..8].copy_from_slice(&3_u32.to_le_bytes());
        assert!(Command::decode(OP_PROCESS, &payload).is_err());
        // Zero frames is meaningless — reject rather than poke the engine.
        let zero_frames = [3_u32.to_le_bytes(), 0_u32.to_le_bytes()].concat();
        assert!(Command::decode(OP_PROCESS, &zero_frames).is_err());
    }

    #[test]
    fn corrupt_length_prefixes_are_rejected() {
        for bad_length in [0_u32, 3, MAX_FRAME_BYTES + 1] {
            let mut wire = bad_length.to_le_bytes().to_vec();
            wire.extend_from_slice(&[0; 8]);
            let error = read_message(&mut wire.as_slice()).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidData, "{bad_length}");
        }
        let oversized = vec![0_u8; MAX_FRAME_BYTES as usize];
        let error = write_message(&mut Vec::new(), 0x30, &oversized).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }
}
