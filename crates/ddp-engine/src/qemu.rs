//! `QemuBackend` — the real engine behind the [`Engine`] trait: one
//! shared `qemu-arm-static <ddp-engine-arm>` subprocess holding
//! `libdseffect.so`, all sessions multiplexed onto it over the framed
//! stdin/stdout protocol (ADR-0002).
//!
//! The backend hides the subprocess lifecycle: [`QemuBackend::start`]
//! spawns and health-probes it (refuse-to-start on a broken staging),
//! and a lost process is reaped and respawned lazily on the next call
//! — that call returns [`EngineError::Crashed`] so the supervisor can
//! recreate the sessions the process took with it.
//!
//! Host-side validation lives here, behind the trait: rates outside
//! the engine's set and non-stereo blocks are rejected up front — the
//! engine's own handling is a footgun (a bad rate silently falls back
//! to 44100 while replying success; mono tears the graph down and
//! poisons the handle).

use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command as ProcessCommand, Stdio};
use std::sync::Mutex;

use crate::protocol::{
    Command, STATUS_NO_SESSION, STATUS_OK, decode_get_params_reply, param_name, read_reply,
    write_message,
};
use crate::{Engine, EngineError, Result, SessionId, VisFrame};

/// The rates `EFFECT_CMD_SET_CONFIG` honours — the same gate the shim
/// enforces, applied host-side so the engine never sees a bad rate.
const SUPPORTED_RATES: [u32; 3] = [44_100, 48_000, 32_000];

/// Samples in the fixed vis tail (`vnbg ‖ vnbe ‖ vcbg ‖ vcbe`).
const VIS_TAIL_SAMPLES: usize = 80;

/// The engine subprocess's pipes, live while the process is.
struct Io {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
}

/// The QEMU subprocess backend (ADR-0002) — see the module docs.
pub struct QemuBackend {
    engine_dir: PathBuf,
    /// `None` between a detected crash and the next call's respawn.
    io: Mutex<Option<Io>>,
}

impl QemuBackend {
    /// Spawns the shared engine subprocess from `engine_dir` (the
    /// directory holding `ddp-engine-arm`, `libdseffect.so`, and its
    /// stub libraries — beside the daemon binary in production) and
    /// health-probes it with one create/destroy round trip, so a
    /// broken staging refuses to start instead of failing silently
    /// later.
    ///
    /// # Errors
    ///
    /// Any spawn or probe failure, with the cause (`RUST_LOG=debug`
    /// additionally surfaces the engine's own log).
    ///
    /// # Panics
    ///
    /// Never in practice: the backend lock is not poisoned.
    pub fn start(engine_dir: impl Into<PathBuf>) -> io::Result<Self> {
        let backend = Self {
            engine_dir: engine_dir.into(),
            io: Mutex::new(None),
        };
        let mut io = backend.spawn()?;
        probe(&mut io)?;
        *backend.io.lock().expect("backend lock") = Some(io);
        Ok(backend)
    }

    /// The live subprocess's pid — `None` between a detected crash and
    /// the next call's respawn.
    ///
    /// # Panics
    ///
    /// Never in practice: the backend lock is not poisoned.
    #[must_use]
    pub fn pid(&self) -> Option<u32> {
        self.io
            .lock()
            .expect("backend lock")
            .as_ref()
            .map(|io| io.child.id())
    }

    /// Spawns a fresh subprocess, wiring its stderr (the engine log)
    /// into `tracing`.
    fn spawn(&self) -> io::Result<Io> {
        let mut child = shim_command(&self.engine_dir).spawn().map_err(|error| {
            io::Error::new(
                error.kind(),
                format!("spawn qemu-arm-static: {error} (apt install qemu-user-static?)"),
            )
        })?;
        let stdin = child.stdin.take().expect("stdin is piped");
        let stdout = child.stdout.take().expect("stdout is piped");
        forward_engine_log(child.stderr.take().expect("stderr is piped"));
        tracing::info!(pid = child.id(), "engine subprocess spawned");
        Ok(Io {
            child,
            stdin,
            stdout,
        })
    }

    /// Sends one command and awaits its reply, respawning a lost
    /// subprocess first. Any pipe failure reaps the process and
    /// surfaces [`EngineError::Crashed`]; the next call respawns.
    fn call(&self, command: &Command) -> Result<(i32, Vec<u8>)> {
        let mut guard = self.io.lock().expect("backend lock");
        if guard.is_none() {
            let io = self
                .spawn()
                .map_err(|error| EngineError::Crashed(error.to_string()))?;
            *guard = Some(io);
        }
        let io = guard.as_mut().expect("spawned above");
        round_trip(io, command).map_err(|error| {
            reap(&mut guard);
            tracing::error!(%error, "engine subprocess lost");
            EngineError::Crashed(error.to_string())
        })
    }

    /// A reply that doesn't fit its layout means the stream is
    /// desynced — unrecoverable: reap now, respawn on the next call.
    fn desync(&self, context: &str) -> EngineError {
        reap(&mut self.io.lock().expect("backend lock"));
        tracing::error!(context, "engine protocol desync");
        EngineError::Crashed(format!("protocol desync: {context}"))
    }

    /// Maps a status-only reply onto the trait's error vocabulary.
    fn expect_ok(id: SessionId, status: i32) -> Result<()> {
        match status {
            STATUS_OK => Ok(()),
            STATUS_NO_SESSION => Err(EngineError::SessionNotFound(id)),
            status => Err(EngineError::Rejected { status }),
        }
    }
}

impl Engine for QemuBackend {
    fn create_session(&self, sample_rate: u32) -> Result<SessionId> {
        validate_rate(sample_rate)?;
        let (status, reply) = self.call(&Command::CreateSession { sample_rate })?;
        if status != STATUS_OK {
            return Err(EngineError::Rejected { status });
        }
        let id = reply
            .as_slice()
            .try_into()
            .map(u32::from_le_bytes)
            .map_err(|_| self.desync("CreateSession reply is not a u32 id"))?;
        Ok(SessionId(id))
    }

    fn destroy_session(&self, id: SessionId) -> Result<()> {
        let (status, _) = self.call(&Command::DestroySession { session_id: id.0 })?;
        Self::expect_ok(id, status)
    }

    fn set_enabled(&self, id: SessionId, enabled: bool) -> Result<()> {
        let (status, _) = self.call(&Command::SetEnabled {
            session_id: id.0,
            enabled,
        })?;
        Self::expect_ok(id, status)
    }

    fn set_params(&self, id: SessionId, params: &[(&str, &[i16])]) -> Result<()> {
        let params = params
            .iter()
            .map(|&(name, values)| validate_name(name).map(|packed| (packed, values.to_vec())))
            .collect::<Result<Vec<_>>>()?;
        let (status, _) = self.call(&Command::SetParams {
            session_id: id.0,
            params,
        })?;
        Self::expect_ok(id, status)
    }

    fn get_params(&self, id: SessionId, names: &[&str]) -> Result<Vec<Vec<i16>>> {
        let names = names
            .iter()
            .map(|name| validate_name(name))
            .collect::<Result<Vec<_>>>()?;
        let count = names.len();
        let (status, reply) = self.call(&Command::GetParams {
            session_id: id.0,
            names,
        })?;
        Self::expect_ok(id, status)?;
        let values = decode_get_params_reply(&reply)
            .map_err(|error| self.desync(&format!("GetParams reply: {error}")))?;
        if values.len() != count {
            return Err(self.desync("GetParams reply entry count"));
        }
        Ok(values)
    }

    fn process(&self, id: SessionId, input: &[i16], output: &mut [i16]) -> Result<VisFrame> {
        validate_block(input, output)?;
        let (status, reply) = self.call(&Command::Process {
            session_id: id.0,
            pcm: input.to_vec(),
        })?;
        Self::expect_ok(id, status)?;
        if reply.len() != (input.len() + VIS_TAIL_SAMPLES) * 2 {
            return Err(self.desync("Process reply is not the block plus the vis tail"));
        }
        let mut samples = reply
            .chunks_exact(2)
            .map(|bytes| i16::from_le_bytes([bytes[0], bytes[1]]));
        for out in output.iter_mut() {
            *out = samples.next().expect("size-checked block");
        }
        let mut band = || std::array::from_fn(|_| samples.next().expect("size-checked tail"));
        Ok(VisFrame {
            vnbg: band(),
            vnbe: band(),
            vcbg: band(),
            vcbe: band(),
        })
    }
}

impl Drop for QemuBackend {
    fn drop(&mut self) {
        // The shim holds no state worth a graceful goodbye, and kill
        // (unlike waiting on a closed stdin) can't hang the daemon's
        // shutdown on a wedged process.
        reap(self.io.get_mut().expect("backend lock"));
    }
}

/// Builds the subprocess invocation — the spawn seam: Slice 12
/// ([#20](https://github.com/avisek/DolbyX/issues/20)) swaps this for a
/// `wsl.exe`-launched shim on Windows without touching the backend.
fn shim_command(engine_dir: &Path) -> ProcessCommand {
    let mut command = ProcessCommand::new("qemu-arm-static");
    command
        .arg("-L")
        .arg("/usr/arm-linux-gnueabihf")
        .arg(engine_dir.join("ddp-engine-arm"))
        .env("LD_LIBRARY_PATH", engine_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

/// One create/destroy round trip — proves qemu ran, the shim loaded
/// `libdseffect.so`, and the protocol answers (a broken staging
/// otherwise looks like a clean exit).
fn probe(io: &mut Io) -> io::Result<()> {
    let (status, reply) = round_trip(
        io,
        &Command::CreateSession {
            sample_rate: 44_100,
        },
    )
    .map_err(|error| io::Error::new(error.kind(), format!("engine probe: {error}")))?;
    if status != STATUS_OK || reply.len() != 4 {
        return Err(io::Error::other(format!(
            "engine probe: CreateSession replied status {status}"
        )));
    }
    let session_id = u32::from_le_bytes(reply.try_into().expect("length-checked"));
    let (status, _) = round_trip(io, &Command::DestroySession { session_id })?;
    if status != STATUS_OK {
        return Err(io::Error::other(format!(
            "engine probe: DestroySession replied status {status}"
        )));
    }
    Ok(())
}

/// Sends one framed command and reads its reply.
fn round_trip(io: &mut Io, command: &Command) -> io::Result<(i32, Vec<u8>)> {
    let (opcode, payload) = command.encode();
    write_message(&mut io.stdin, opcode, &payload)?;
    io.stdin.flush()?;
    read_reply(&mut io.stdout)
}

/// Kills and reaps the subprocess, if one is held — never leaves a
/// zombie behind.
fn reap(io: &mut Option<Io>) {
    if let Some(mut dead) = io.take() {
        let _ = dead.child.kill();
        let _ = dead.child.wait();
    }
}

/// Forwards the shim's stderr — the engine's own log — into `tracing`
/// line by line: the shim's fatal `ddp-engine-arm:` lines at `warn`,
/// the chatty `[EffectDs]` traffic at `debug`.
fn forward_engine_log(stderr: ChildStderr) {
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            let Ok(line) = line else { return };
            if line.starts_with("ddp-engine-arm:") {
                tracing::warn!(target: "ddp_engine::shim", "{line}");
            } else {
                tracing::debug!(target: "ddp_engine::shim", "{line}");
            }
        }
    });
}

/// Rejects rates the engine would mishandle: anything outside
/// {44100, 48000, 32000} silently falls back to 44100 while replying
/// success (`setconfig_probe` Sc5).
fn validate_rate(sample_rate: u32) -> Result<()> {
    if SUPPORTED_RATES.contains(&sample_rate) {
        Ok(())
    } else {
        Err(EngineError::UnsupportedConfig(format!(
            "sample rate {sample_rate} outside the engine's {{44100, 48000, 32000}} \
             (it would silently fall back to 44100)"
        )))
    }
}

/// Rejects blocks that aren't whole interleaved-stereo frames — the
/// engine is stereo-only, and a mono config poisons its handle
/// (`setconfig_probe` Sc6). Never send mono.
fn validate_block(input: &[i16], output: &[i16]) -> Result<()> {
    if output.len() != input.len() {
        return Err(EngineError::UnsupportedConfig(format!(
            "output buffer ({} samples) must mirror the input block ({} samples)",
            output.len(),
            input.len()
        )));
    }
    if input.is_empty() || !input.len().is_multiple_of(2) {
        return Err(EngineError::UnsupportedConfig(format!(
            "blocks are whole interleaved-stereo frames, got {} samples \
             (the engine is stereo-only; mono poisons the handle)",
            input.len()
        )));
    }
    Ok(())
}

/// Packs a 4-CC into wire form, rejecting names that aren't one.
fn validate_name(name: &str) -> Result<crate::protocol::ParamName> {
    if (1..=4).contains(&name.len()) {
        Ok(param_name(name))
    } else {
        Err(EngineError::UnsupportedConfig(format!(
            "parameter name {name:?} is not a 4-CC"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Behavior 3 (issue #16): the engine-footgun configs are rejected
    /// host-side, with the footgun spelled out.
    #[test]
    fn rates_outside_the_engines_set_are_rejected_with_the_footgun_named() {
        for rate in SUPPORTED_RATES {
            assert_eq!(validate_rate(rate), Ok(()), "{rate}");
        }
        let error = validate_rate(96_000).unwrap_err();
        assert_eq!(
            error.to_string(),
            "unsupported config: sample rate 96000 outside the engine's \
             {44100, 48000, 32000} (it would silently fall back to 44100)"
        );
    }

    #[test]
    fn non_stereo_blocks_are_rejected_before_the_engine_sees_them() {
        assert_eq!(validate_block(&[0; 4], &[0; 4]), Ok(()));
        // Odd sample counts are mono-shaped; empty writes nothing.
        for samples in [1, 3, 0] {
            let error = validate_block(&vec![0; samples], &vec![0; samples]).unwrap_err();
            assert!(
                matches!(error, EngineError::UnsupportedConfig(_)),
                "{samples}: {error}"
            );
            assert!(error.to_string().contains("stereo"), "{error}");
        }
        let mismatch = validate_block(&[0; 4], &[0; 2]).unwrap_err();
        assert!(mismatch.to_string().contains("mirror"), "{mismatch}");
    }

    #[test]
    fn param_names_must_be_4ccs() {
        assert_eq!(validate_name("ver"), Ok(*b"ver\0"));
        assert_eq!(validate_name("dvla"), Ok(*b"dvla"));
        assert!(validate_name("").is_err());
        assert!(validate_name("toolong").is_err());
    }
}
