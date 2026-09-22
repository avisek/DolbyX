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
//!
//! On Windows the daemon is a native binary and the subprocess is the
//! same qemu run relayed into WSL2 over `wsl.exe` stdio (issue #20);
//! `engine_dir` names a WSL-side Linux path there — layout and setup
//! in `docs/windows.md`.

use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command as ProcessCommand, Stdio};
use std::sync::Mutex;

use crate::protocol::{
    Command, STATUS_NO_SESSION, STATUS_OK, VIS_TAIL_SAMPLES, decode_get_params_reply, param_name,
    read_reply, write_message,
};
use crate::{Engine, EngineError, Result, SessionId, VisFrame};

/// The rates `EFFECT_CMD_SET_CONFIG` honours — the same gate the shim
/// enforces, applied host-side so the engine never sees a bad rate.
const SUPPORTED_RATES: [u32; 3] = [44_100, 48_000, 32_000];

/// The live engine subprocess: the child plus its protocol pipes.
struct Subprocess {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
}

/// The QEMU subprocess backend (ADR-0002) — see the module docs.
pub struct QemuBackend {
    engine_dir: PathBuf,
    /// `None` between a detected crash and the next call's respawn.
    subprocess: Mutex<Option<Subprocess>>,
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
            subprocess: Mutex::new(None),
        };
        let mut shim = backend.spawn()?;
        probe(&mut shim)?;
        *backend.subprocess.lock().expect("backend lock") = Some(shim);
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
        self.subprocess
            .lock()
            .expect("backend lock")
            .as_ref()
            .map(|shim| shim.child.id())
    }

    /// Spawns a fresh subprocess, wiring its stderr (the engine log)
    /// into `tracing`.
    fn spawn(&self) -> io::Result<Subprocess> {
        let mut command = shim_command(&self.engine_dir);
        let program = command.get_program().to_string_lossy().into_owned();
        let mut child = command.spawn().map_err(|error| {
            io::Error::new(
                error.kind(),
                format!("spawn {program}: {error} ({SPAWN_HINT})"),
            )
        })?;
        let stdin = child.stdin.take().expect("stdin is piped");
        let stdout = child.stdout.take().expect("stdout is piped");
        forward_engine_log(child.stderr.take().expect("stderr is piped"));
        tracing::info!(pid = child.id(), "engine subprocess spawned");
        Ok(Subprocess {
            child,
            stdin,
            stdout,
        })
    }

    /// Sends one command and awaits its reply, respawning a lost
    /// subprocess first. Any pipe failure reaps the process and
    /// surfaces [`EngineError::Crashed`]; the next call respawns.
    fn call(&self, command: &Command) -> Result<(i32, Vec<u8>)> {
        let mut guard = self.subprocess.lock().expect("backend lock");
        if guard.is_none() {
            let shim = self
                .spawn()
                .map_err(|error| EngineError::Crashed(error.to_string()))?;
            *guard = Some(shim);
        }
        let shim = guard.as_mut().expect("spawned above");
        round_trip(shim, command).map_err(|error| {
            reap(&mut guard);
            tracing::error!(%error, "engine subprocess lost");
            EngineError::Crashed(error.to_string())
        })
    }

    /// A reply that doesn't fit its layout means the stream is
    /// desynced — unrecoverable: reap now, respawn on the next call.
    fn desync(&self, context: &str) -> EngineError {
        reap(&mut self.subprocess.lock().expect("backend lock"));
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
            gebg: band(),
        })
    }
}

impl Drop for QemuBackend {
    fn drop(&mut self) {
        // The shim holds no state worth a graceful goodbye, and kill
        // (unlike waiting on a closed stdin) can't hang the daemon's
        // shutdown on a wedged process.
        reap(self.subprocess.get_mut().expect("backend lock"));
    }
}

/// What a failed spawn names, per platform (the daemon's start error
/// carries the fix-it action; this names the immediate cause).
#[cfg(unix)]
const SPAWN_HINT: &str = "apt install qemu-user-static?";
#[cfg(windows)]
const SPAWN_HINT: &str = "is WSL2 installed?";

/// Builds the subprocess invocation — the spawn seam (issue #20): the
/// same qemu run everywhere, launched natively on Unix and relayed into
/// WSL2 on Windows, protocol and framing identical.
fn shim_command(engine_dir: &Path) -> ProcessCommand {
    let mut command = shim_invocation(engine_dir);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

/// The native invocation: `qemu-arm-static` runs the shim, its staged
/// libraries resolved from `engine_dir` via `LD_LIBRARY_PATH`.
#[cfg(unix)]
fn shim_invocation(engine_dir: &Path) -> ProcessCommand {
    let mut command = ProcessCommand::new("qemu-arm-static");
    command
        .arg("-L")
        .arg("/usr/arm-linux-gnueabihf")
        .arg(engine_dir.join("ddp-engine-arm"))
        .env("LD_LIBRARY_PATH", engine_dir);
    command
}

/// The Windows invocation: the same run inside WSL2, stdio relayed
/// binary-clean by `wsl.exe` (the v1-proven path). `--exec` skips the
/// default shell (dotfile output would corrupt the framed stdout) and
/// `-E` sets the guest environment (`wsl.exe` forwards no Windows
/// environment). `engine_dir` names a WSL-side Linux path here
/// (layout: `docs/windows.md`) — joined with `/` by hand, since
/// `Path::join` would insert `\`.
#[cfg(windows)]
fn shim_invocation(engine_dir: &Path) -> ProcessCommand {
    use std::os::windows::process::CommandExt;
    // Never flash a console window when spawned from a windowless
    // context (v1 set the same flag).
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let dir = engine_dir.to_string_lossy();
    let mut command = ProcessCommand::new("wsl.exe");
    command
        .arg("--exec")
        .arg("qemu-arm-static")
        .arg("-E")
        .arg(format!("LD_LIBRARY_PATH={dir}"))
        .arg("-L")
        .arg("/usr/arm-linux-gnueabihf")
        .arg(format!("{dir}/ddp-engine-arm"))
        .creation_flags(CREATE_NO_WINDOW);
    command
}

/// One create/destroy round trip — proves qemu ran, the shim loaded
/// `libdseffect.so`, and the protocol answers (a broken staging
/// otherwise looks like a clean exit).
fn probe(shim: &mut Subprocess) -> io::Result<()> {
    let (status, reply) = round_trip(
        shim,
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
    let (status, _) = round_trip(shim, &Command::DestroySession { session_id })?;
    if status != STATUS_OK {
        return Err(io::Error::other(format!(
            "engine probe: DestroySession replied status {status}"
        )));
    }
    Ok(())
}

/// Sends one framed command and reads its reply.
fn round_trip(shim: &mut Subprocess, command: &Command) -> io::Result<(i32, Vec<u8>)> {
    let (opcode, payload) = command.encode();
    write_message(&mut shim.stdin, opcode, &payload)?;
    shim.stdin.flush()?;
    read_reply(&mut shim.stdout)
}

/// Kills and reaps the subprocess, if one is held — never leaves a
/// zombie behind.
fn reap(subprocess: &mut Option<Subprocess>) {
    if let Some(mut dead) = subprocess.take() {
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
    use std::ffi::OsStr;

    use super::*;

    /// The spawn seam, Unix side: `qemu-arm-static` runs the shim
    /// directly, its staged libraries resolved via `LD_LIBRARY_PATH`.
    #[cfg(unix)]
    #[test]
    fn the_shim_runs_under_qemu_with_its_libraries_beside_it() {
        let command = shim_command(Path::new("/opt/dolbyx/engine"));
        assert_eq!(command.get_program(), "qemu-arm-static");
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(
            args,
            [
                "-L",
                "/usr/arm-linux-gnueabihf",
                "/opt/dolbyx/engine/ddp-engine-arm"
            ]
            .map(OsStr::new)
        );
        assert!(
            command
                .get_envs()
                .any(|(key, value)| key == "LD_LIBRARY_PATH"
                    && value == Some(OsStr::new("/opt/dolbyx/engine")))
        );
    }

    /// The spawn seam, Windows side (issue #20): the identical qemu run
    /// relayed through `wsl.exe --exec` — no shell in the stdio path —
    /// with `engine_dir` kept a forward-slash WSL path.
    #[cfg(windows)]
    #[test]
    fn the_shim_is_relayed_into_wsl2_without_a_shell() {
        let command = shim_command(Path::new("/opt/dolbyx/engine"));
        assert_eq!(command.get_program(), "wsl.exe");
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(
            args,
            [
                "--exec",
                "qemu-arm-static",
                "-E",
                "LD_LIBRARY_PATH=/opt/dolbyx/engine",
                "-L",
                "/usr/arm-linux-gnueabihf",
                "/opt/dolbyx/engine/ddp-engine-arm",
            ]
            .map(OsStr::new)
        );
    }

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
