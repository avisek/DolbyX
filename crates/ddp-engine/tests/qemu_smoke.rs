//! Slice 06 smoke harness (#14): drives the real `ddp-engine-arm`
//! subprocess — real `libdseffect.so` under `qemu-arm-static`, nothing
//! mocked — over the framed stdin/stdout protocol.
//!
//! Feature-gated `qemu`. Prerequisites: `apt install
//! gcc-arm-linux-gnueabihf g++-arm-linux-gnueabihf qemu-user-static`
//! plus `rustup target add armv7-unknown-linux-gnueabihf` (`just
//! qemu-test` provisions the Rust side and runs this).
#![cfg(feature = "qemu")]

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command as ProcessCommand, Stdio};
use std::sync::OnceLock;

use ddp_engine::protocol::{
    self, Command, STATUS_INVALID, STATUS_NO_SESSION, STATUS_OK, read_reply, write_message,
};

/// Frames per process block — the size the probes drive.
const FRAMES: usize = 256;
/// Blocks that comfortably outlast both engine crossfades (enable 7560
/// samples, disable 5512 — `tools/ddp_probe/README.md` #6).
const CROSSFADE_BLOCKS: usize = 40;

/// One interleaved-stereo block of a 431 Hz sine at `amp`, phase-locked
/// to `block` so consecutive blocks continue the tone.
#[expect(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    reason = "sample indices and |sine| ≤ amp both stay far inside range"
)]
fn sine_block(block: usize, rate: u32, amp: f64) -> Vec<i16> {
    let mut pcm = Vec::with_capacity(FRAMES * 2);
    for i in 0..FRAMES {
        let t = (block * FRAMES + i) as f64 / f64::from(rate);
        let sample = (amp * (2.0 * std::f64::consts::PI * 431.0 * t).sin()) as i16;
        pcm.push(sample);
        pcm.push(sample);
    }
    pcm
}

/// Builds the shim, stages it beside `libdseffect.so` + the proven
/// Android stubs from `tools/ddp_probe`, once per test run.
fn staged_dir() -> &'static Path {
    static STAGE: OnceLock<PathBuf> = OnceLock::new();
    STAGE.get_or_init(|| {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(2)
            .expect("workspace root")
            .to_path_buf();
        let run = |program: &str, args: &[&str]| {
            let status = ProcessCommand::new(program)
                .args(args)
                .current_dir(&root)
                .status()
                .unwrap_or_else(|error| panic!("spawn {program}: {error}"));
            assert!(status.success(), "{program} {args:?} failed: {status}");
        };
        run(
            env!("CARGO"),
            &[
                "build",
                "-p",
                "ddp-engine-arm",
                "--target",
                "armv7-unknown-linux-gnueabihf",
                "--release",
            ],
        );
        run("make", &["-sC", "tools/ddp_probe", "stage"]);

        let stage = root.join("target/qemu-stage");
        fs::create_dir_all(stage.join("logs")).expect("create stage dir");
        let staged_libs = root.join("tools/ddp_probe/build/lib");
        for entry in fs::read_dir(&staged_libs).expect("read staged libs") {
            let entry = entry.expect("staged lib entry");
            // fs::copy follows the sysroot symlinks to real files.
            fs::copy(entry.path(), stage.join(entry.file_name())).expect("stage lib");
        }
        let shim = root.join("target/armv7-unknown-linux-gnueabihf/release/ddp-engine-arm");
        fs::copy(&shim, stage.join("ddp-engine-arm")).expect("stage shim");
        stage
    })
}

/// One live shim subprocess under qemu, engine log teed to a file.
struct Shim {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: ChildStdout,
    stderr_path: PathBuf,
}

impl Shim {
    /// Spawns a fresh shim; `name` keys its engine-log file.
    fn spawn(name: &str) -> Self {
        let stage = staged_dir();
        let stderr_path = stage.join("logs").join(format!("{name}.stderr"));
        let stderr = fs::File::create(&stderr_path).expect("create stderr log");
        let mut child = ProcessCommand::new("qemu-arm-static")
            .arg("-L")
            .arg("/usr/arm-linux-gnueabihf")
            .arg(stage.join("ddp-engine-arm"))
            .env("LD_LIBRARY_PATH", stage)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(stderr)
            .spawn()
            .expect("spawn qemu-arm-static (apt install qemu-user-static?)");
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("shim stdout");
        Self {
            child,
            stdin,
            stdout,
            stderr_path,
        }
    }

    /// Sends one raw frame and awaits its reply.
    fn send_raw(&mut self, opcode: u32, payload: &[u8]) -> (i32, Vec<u8>) {
        let stdin = self.stdin.as_mut().expect("stdin open");
        write_message(stdin, opcode, payload).expect("write frame");
        stdin.flush().expect("flush frame");
        read_reply(&mut self.stdout).unwrap_or_else(|error| {
            panic!(
                "no reply to {opcode:#x}: {error}\n--- engine log ---\n{}",
                self.engine_log()
            )
        })
    }

    /// Sends one command and awaits its reply.
    fn send(&mut self, command: &Command) -> (i32, Vec<u8>) {
        let (opcode, payload) = command.encode();
        self.send_raw(opcode, &payload)
    }

    /// `CreateSession`, asserting success; returns the session id.
    fn create(&mut self, sample_rate: u32) -> u32 {
        let (status, reply) = self.send(&Command::CreateSession { sample_rate });
        assert_eq!(
            status,
            STATUS_OK,
            "CreateSession({sample_rate})\n--- engine log ---\n{}",
            self.engine_log()
        );
        u32::from_le_bytes(reply.as_slice().try_into().expect("u32 session id reply"))
    }

    /// `SetEnabled`, asserting success.
    fn set_enabled(&mut self, session_id: u32, enabled: bool) {
        let (status, reply) = self.send(&Command::SetEnabled {
            session_id,
            enabled,
        });
        assert_eq!(status, STATUS_OK, "SetEnabled({session_id}, {enabled})");
        assert!(reply.is_empty(), "SetEnabled reply is empty");
    }

    /// `Process` one block, asserting success; returns the output PCM.
    fn process(&mut self, session_id: u32, pcm: &[i16]) -> Vec<i16> {
        let (status, reply) = self.send(&Command::Process {
            session_id,
            pcm: pcm.to_vec(),
        });
        assert_eq!(status, STATUS_OK, "Process({session_id})");
        assert_eq!(reply.len(), pcm.len() * 2, "reply carries the block");
        reply
            .chunks_exact(2)
            .map(|bytes| i16::from_le_bytes([bytes[0], bytes[1]]))
            .collect()
    }

    /// Everything the engine has logged so far.
    fn engine_log(&self) -> String {
        fs::read_to_string(&self.stderr_path).unwrap_or_default()
    }

    /// Closes stdin (the shutdown signal), waits for a clean exit, and
    /// returns the full engine log.
    fn finish(mut self) -> String {
        drop(self.stdin.take());
        let status = self.child.wait().expect("wait for shim");
        assert!(status.success(), "shim exit: {status}");
        self.engine_log()
    }
}

impl Drop for Shim {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Creating a session issues `EFFECT_CMD_INIT` plus exactly one
/// `EFFECT_CMD_SET_CONFIG`, rebuilding the engine at the requested rate
/// (48000 ≠ the engine's 44100 default, so the log must show the
/// rebuilt `Ds1ap`).
#[test]
fn create_session_initialises_at_the_requested_rate() {
    let mut shim = Shim::spawn("create_48000");
    let session = shim.create(48_000);
    assert_eq!(session, 1, "first minted session id");
    let log = shim.finish();
    assert!(log.contains("EFFECT_CMD_INIT ReplyData=0"), "{log}");
    assert!(
        log.contains("EFFECT_CMD_SET_CONFIG Effect_setConfig() returned, ReplyData=0"),
        "{log}"
    );
    assert!(
        log.contains("sampleRate 48000"),
        "Ds1ap must be rebuilt at the requested rate:\n{log}"
    );
    assert_eq!(
        log.matches("Effect_command() EFFECT_CMD_SET_CONFIG")
            .count(),
        1,
        "exactly one SET_CONFIG per session (epic invariant):\n{log}"
    );
}

/// One shared process multiplexes sessions: two coexist with distinct
/// ids, and destroying one leaves the other processing.
#[test]
fn two_sessions_coexist_and_destroy_is_isolated() {
    let mut shim = Shim::spawn("two_sessions");
    let first = shim.create(44_100);
    let second = shim.create(48_000);
    assert_ne!(first, second, "ids are independent");

    let (status, reply) = shim.send(&Command::DestroySession { session_id: first });
    assert_eq!((status, reply.len()), (STATUS_OK, 0));

    // The survivor still processes…
    let input = sine_block(0, 48_000, 8000.0);
    let output = shim.process(second, &input);
    assert_eq!(output.len(), input.len());

    // …while the destroyed id is gone for every op.
    let (status, _) = shim.send(&Command::Process {
        session_id: first,
        pcm: input,
    });
    assert_eq!(status, STATUS_NO_SESSION);
    let (status, _) = shim.send(&Command::DestroySession { session_id: first });
    assert_eq!(status, STATUS_NO_SESSION);
    shim.finish();
}

/// A never-enabled session bypasses from the first block: in WRITE
/// mode the engine deposits the dry input into the output itself
/// (`setconfig_probe` Sc9) — `OUT == IN`, status 0, no shim-side copy.
#[test]
fn never_enabled_session_deposits_the_dry_input() {
    let mut shim = Shim::spawn("never_enabled");
    let session = shim.create(44_100);
    for block in 0..3 {
        let input = sine_block(block, 44_100, 8000.0);
        let output = shim.process(session, &input);
        assert_eq!(output, input, "bypass is the engine's dry deposit");
    }
    shim.finish();
}

/// Disabling mid-stream is engine-owned: a wet→dry crossfade, then
/// bypassed blocks deposit the dry input — every block replies status
/// 0 (`-ENODATA` handled as bypass, never surfaced to the caller).
#[test]
fn disable_crossfades_to_dry_without_surfacing_errors() {
    let mut shim = Shim::spawn("disable_mid_stream");
    let session = shim.create(44_100);
    shim.set_enabled(session, true);
    for block in 0..CROSSFADE_BLOCKS {
        shim.process(session, &sine_block(block, 44_100, 8000.0));
    }
    shim.set_enabled(session, false);
    let mut last = (Vec::new(), Vec::new());
    for block in CROSSFADE_BLOCKS..2 * CROSSFADE_BLOCKS {
        let input = sine_block(block, 44_100, 8000.0);
        // `process` asserts status 0 — a surfaced -ENODATA fails here.
        let output = shim.process(session, &input);
        last = (input, output);
    }
    assert_eq!(last.1, last.0, "past the crossfade the output goes dry");
    let log = shim.finish();
    assert!(
        log.contains("Starting graceful disable over 5512 samples"),
        "{log}"
    );
}

/// Malformed frames — unknown opcode, short payload, ops on dead ids,
/// engine-footgun rates — get an error status reply and the shim stays
/// alive for the next well-formed frame.
#[test]
fn malformed_frames_error_without_killing_the_shim() {
    let mut shim = Shim::spawn("malformed");

    let (status, reply) = shim.send_raw(0xFF, &[]);
    assert_eq!((status, reply.len()), (STATUS_INVALID, 0), "bad opcode");

    let (status, _) = shim.send_raw(protocol::OP_CREATE_SESSION, &[0x44, 0xAC]);
    assert_eq!(status, STATUS_INVALID, "short payload");

    let (status, _) = shim.send(&Command::SetEnabled {
        session_id: 9,
        enabled: true,
    });
    assert_eq!(status, STATUS_NO_SESSION, "unknown session");

    // 96000 would *silently fall back to 44100* inside the engine
    // (setconfig_probe Sc5) — the shim must reject it up front.
    let (status, _) = shim.send(&Command::CreateSession {
        sample_rate: 96_000,
    });
    assert_eq!(status, STATUS_INVALID, "unsupported rate");

    // Still alive: a well-formed create + process works.
    let session = shim.create(32_000);
    let input = sine_block(0, 32_000, 8000.0);
    assert_eq!(shim.process(session, &input), input);
    shim.finish();
}

/// The slice's tracer bullet: create at 44100, enable, process a sine
/// past the enable crossfade — the effect audibly transforms the tone
/// (engine power-on defaults have the Volume Leveller active).
#[test]
fn enabled_session_transforms_a_test_tone() {
    let mut shim = Shim::spawn("tracer");
    let session = shim.create(44_100);
    shim.set_enabled(session, true);
    let mut last = (Vec::new(), Vec::new());
    for block in 0..CROSSFADE_BLOCKS {
        let input = sine_block(block, 44_100, 8000.0);
        let output = shim.process(session, &input);
        last = (input, output);
    }
    assert_ne!(last.1, last.0, "enabled processing must not be identity");
    shim.finish();
}
