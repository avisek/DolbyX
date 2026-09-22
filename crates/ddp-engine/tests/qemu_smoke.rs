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
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command as ProcessCommand, Stdio};

use ddp_engine::protocol::{
    self, Command, STATUS_INVALID, STATUS_NO_SESSION, STATUS_OK, VIS_TAIL_SAMPLES,
    decode_get_params_reply, param_name, read_reply, write_message,
};
use ddp_engine::test_support::staged_engine_dir;

/// Frames per process block — the size the probes drive.
const FRAMES: usize = 256;
/// Blocks that comfortably outlast both engine crossfades (enable 7560
/// samples, disable 5512 — `tools/ddp_probe/README.md` #6).
const CROSSFADE_BLOCKS: usize = 40;
/// Blocks that let the GEQ gain smoother settle after a change
/// (`akctl_probe`'s SETTLE).
const SETTLE_BLOCKS: usize = 150;
/// The standard 20-band GEQ centre frequencies the original service
/// establishes (verbatim from `akctl_probe`); band 4 = 431 Hz.
const GEBF: [i16; 20] = [
    43, 129, 215, 301, 431, 603, 775, 947, 1206, 1550, 2067, 2756, 3618, 4651, 5685, 7063, 8958,
    11025, 13781, 18777,
];

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

/// Root-mean-square of one PCM block — the probes' loudness measure.
#[expect(
    clippy::cast_precision_loss,
    reason = "block sample counts stay far inside f64's exact range"
)]
fn rms(pcm: &[i16]) -> f64 {
    let squares = pcm
        .iter()
        .map(|&s| f64::from(s) * f64::from(s))
        .sum::<f64>();
    (squares / pcm.len() as f64).sqrt()
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
        let stage = staged_engine_dir();
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

    /// `Process` one block, asserting success and the reply shape —
    /// the PCM block plus exactly the fixed vis tail, on **every**
    /// reply (bypassed blocks included). Returns `(pcm, vis)`.
    fn process(&mut self, session_id: u32, pcm: &[i16]) -> (Vec<i16>, Vec<i16>) {
        let (status, reply) = self.send(&Command::Process {
            session_id,
            pcm: pcm.to_vec(),
        });
        assert_eq!(status, STATUS_OK, "Process({session_id})");
        assert_eq!(
            reply.len(),
            (pcm.len() + VIS_TAIL_SAMPLES) * 2,
            "reply carries the block plus the fixed vis tail"
        );
        let mut samples: Vec<i16> = reply
            .chunks_exact(2)
            .map(|bytes| i16::from_le_bytes([bytes[0], bytes[1]]))
            .collect();
        let vis = samples.split_off(pcm.len());
        (samples, vis)
    }

    /// `SetParams` of one name-addressed batch, asserting success.
    fn set_params(&mut self, session_id: u32, params: &[(&str, &[i16])]) {
        let (status, reply) = self.send(&Command::SetParams {
            session_id,
            params: params
                .iter()
                .map(|&(name, values)| (param_name(name), values.to_vec()))
                .collect(),
        });
        assert_eq!(status, STATUS_OK, "SetParams({params:?})");
        assert!(reply.is_empty(), "SetParams reply is empty");
    }

    /// `GetParams`, asserting success; returns the values per name.
    fn get_params(&mut self, session_id: u32, names: &[&str]) -> Vec<Vec<i16>> {
        let (status, reply) = self.send(&Command::GetParams {
            session_id,
            names: names.iter().map(|name| param_name(name)).collect(),
        });
        assert_eq!(status, STATUS_OK, "GetParams({names:?})");
        decode_get_params_reply(&reply).expect("well-formed GetParams reply")
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
    let (output, _) = shim.process(second, &input);
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
        let (output, _) = shim.process(session, &input);
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
        let (output, _) = shim.process(session, &input);
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
    assert_eq!(shim.process(session, &input).0, input);
    shim.finish();
}

/// One `SetParams` batch of scalars lands atomically; `GetParams`
/// reads both back from the live registry (in-range values verbatim).
#[test]
fn a_scalar_batch_reads_back_verbatim() {
    let mut shim = Shim::spawn("scalar_batch");
    let session = shim.create(44_100);
    shim.set_params(session, &[("dvla", &[8]), ("deon", &[1])]);
    assert_eq!(shim.get_params(session, &["dvla", "deon"]), [[8], [1]]);
    shim.finish();
}

/// An out-of-range write is silently clamped to the engine's own
/// bounds — `vmb` clamps at 192, not the published table's 240
/// (probe §7 / §9c ground truth), which is why the daemon validates
/// against `parameters.toml` up front.
#[test]
fn out_of_range_writes_clamp_to_the_engines_own_bounds() {
    let mut shim = Shim::spawn("clamp_vmb");
    let session = shim.create(44_100);
    shim.set_params(session, &[("vmb", &[480])]);
    assert_eq!(shim.get_params(session, &["vmb"]), [[192]]);
    shim.finish();
}

/// A write to a write-protected leaf (`vnnb`, the native band count)
/// stores nothing and surfaces nothing: status 0, value unchanged —
/// the engine's own silent-no-op semantics, forwarded as-is.
#[test]
fn write_protected_leaves_no_op_silently() {
    let mut shim = Shim::spawn("write_protected");
    let session = shim.create(44_100);
    let before = shim.get_params(session, &["vnnb"]);
    shim.set_params(session, &[("vnnb", &[5])]); // asserts status 0
    assert_eq!(shim.get_params(session, &["vnnb"]), before);
    shim.finish();
}

/// `GetParams` is a true per-param read of engine-owned state: the
/// `ver` readout's four slots format to the engine version `2.0.4.0`
/// (what cmd 6 reports — but read AK-direct, no cmd protocol).
#[test]
fn ver_readout_carries_the_engine_version() {
    let mut shim = Shim::spawn("ver_readout");
    let session = shim.create(44_100);
    assert_eq!(shim.get_params(session, &["ver"]), [[2, 0, 4, 0]]);
    shim.finish();
}

/// AK registries are per-handle: a write on one session never leaks
/// into another — the second session keeps the engine's power-on
/// default (`dvla` = 7, probe `dump defaults`).
#[test]
fn set_params_is_isolated_per_session() {
    let mut shim = Shim::spawn("param_isolation");
    let first = shim.create(44_100);
    let second = shim.create(44_100);
    shim.set_params(first, &[("dvla", &[3])]);
    assert_eq!(shim.get_params(first, &["dvla"]), [[3]]);
    assert_eq!(
        shim.get_params(second, &["dvla"]),
        [[7]],
        "the sibling session keeps its own power-on registry"
    );
    shim.finish();
}

/// A structural batch (`genb` = 20 + 20-band `gebf` + `gebg`) reshapes
/// the 10-band power-on GEQ mid-stream — `GetParams` confirms the new
/// count and the visualizer's native grid readout stays consistent
/// (rate-derived, untouched by a GEQ reshape).
#[test]
fn a_structural_batch_reshapes_from_power_on_state() {
    let mut shim = Shim::spawn("reshape_batch");
    let session = shim.create(44_100);
    shim.set_enabled(session, true);
    for block in 0..5 {
        shim.process(session, &sine_block(block, 44_100, 8000.0));
    }
    assert_eq!(
        shim.get_params(session, &["genb"]),
        [[10]],
        "the engine powers on 10-band"
    );
    assert_eq!(
        shim.get_params(session, &["vnnb"]),
        [[20]],
        "the native grid fills from the rate at the first blocks"
    );
    shim.set_params(
        session,
        &[("genb", &[20]), ("gebf", &GEBF), ("gebg", &[0; 20])],
    );
    assert_eq!(shim.get_params(session, &["genb"]), [[20]]);
    for block in 5..10 {
        shim.process(session, &sine_block(block, 44_100, 8000.0));
    }
    assert_eq!(
        shim.get_params(session, &["vnnb"]),
        [[20]],
        "the native grid readout survives the reshape"
    );
    shim.finish();
}

/// The shim's commit-leaf touch: staging `gebf` *without* `gebg` in
/// the batch still reshapes — bare stager writes are inert in the
/// engine (`reshape_probe` A), so the observable reshape proves the
/// shim re-wrote the group's commit leaf itself.
#[test]
fn staging_without_the_commit_leaf_still_reshapes() {
    let mut shim = Shim::spawn("commit_touch");
    let session = shim.create(44_100);
    // GEQ-only + 20 bands with +10 dB on band 4 (431 Hz) — the
    // reshape_probe isolation (every other feature off, so leveler /
    // maximizer dynamics can't mask the reshape); `gebg` is in this
    // batch, so it commits itself.
    let mut boosted = [0_i16; 20];
    boosted[4] = 160;
    shim.set_params(
        session,
        &[
            ("dvle", &[0]),
            ("dvme", &[0]),
            ("vmon", &[0]),
            ("deon", &[0]),
            ("ieon", &[0]),
            ("aoon", &[0]),
            ("vdhe", &[0]),
            ("vspe", &[0]),
            ("ngon", &[0]),
            ("geon", &[1]),
            ("genb", &[20]),
            ("gebf", &GEBF),
            ("gebg", &boosted),
        ],
    );
    shim.set_enabled(session, true);
    let mut block = 0;
    let mut run = |shim: &mut Shim, blocks: usize| {
        let mut last = Vec::new();
        for _ in 0..blocks {
            last = shim.process(session, &sine_block(block, 44_100, 2000.0)).0;
            block += 1;
        }
        rms(&last)
    };
    let boosted_rms = run(&mut shim, CROSSFADE_BLOCKS + SETTLE_BLOCKS);

    // Move band 4's centre 431 → 6000 Hz — stager only, no `gebg`.
    let mut moved = GEBF;
    moved[4] = 6000;
    shim.set_params(session, &[("gebf", &moved)]);
    let moved_rms = run(&mut shim, SETTLE_BLOCKS);

    assert!(
        moved_rms < boosted_rms * 0.8,
        "the boost must leave 431 Hz once the shim commits the staged \
         reshape: boosted rms {boosted_rms:.1}, moved rms {moved_rms:.1}"
    );
    shim.finish();
}

/// Every `Process` reply carries the fixed vis tail —
/// `Shim::process` asserts the exact length on every call, including
/// the bypassed block here (vis is process-driven, not power-gated).
/// With a tone playing and one `[vcnb, vcbf, ven]` batch (the custom
/// grid boots unconfigured — `vcnb` = 0 — and its pair stays zero
/// until the host writes the grid; `ven` starts 0 on a fresh session
/// and gates whether the DSP fills the arrays; the "seeded"
/// identity the probes saw is a side effect of their cmd-3 init flow),
/// the native pair goes live and the custom pair mirrors it — the
/// custom grid here *is* the native table. The fifth array is the
/// `gebg` in force: the registry's power-on zeros, then the last
/// `set_params` write verbatim.
#[test]
#[expect(
    clippy::similar_names,
    reason = "vnbg/vnbe/vcbg/vcbe/gebg are the engine's own 4-CC names"
)]
fn every_process_reply_carries_the_vis_tail() {
    let mut shim = Shim::spawn("vis_tail");
    let session = shim.create(44_100);

    // Bypassed (never enabled yet): the helper's length assert is the
    // "tail rides bypass" proof.
    shim.process(session, &sine_block(0, 44_100, 8000.0));

    shim.set_enabled(session, true);
    for block in 1..=CROSSFADE_BLOCKS {
        shim.process(session, &sine_block(block, 44_100, 8000.0));
    }
    // GEBF doubles as the 44.1 kHz native grid — custom mirrors native.
    shim.set_params(session, &[("vcnb", &[20]), ("vcbf", &GEBF), ("ven", &[1])]);
    let mut vis = Vec::new();
    for block in CROSSFADE_BLOCKS + 1..=2 * CROSSFADE_BLOCKS {
        vis = shim.process(session, &sine_block(block, 44_100, 8000.0)).1;
    }
    let (vnbg, rest) = vis.split_at(20);
    let (vnbe, rest) = rest.split_at(20);
    let (vcbg, rest) = rest.split_at(20);
    let (vcbe, gebg) = rest.split_at(20);
    assert!(
        vnbg.iter().any(|&gain| gain != 0),
        "native gains are live: {vnbg:?}"
    );
    assert!(
        vnbe.iter().any(|&excitation| excitation != 0),
        "native excitations are live: {vnbe:?}"
    );
    assert_eq!(vcbg, vnbg, "custom grid == native grid ⇒ mirror");
    assert_eq!(vcbe, vnbe, "custom grid == native grid ⇒ mirror");
    assert_eq!(gebg, [0; 20], "power-on gebg before any write");

    // The gebg slot echoes the last write — the registry value the
    // DSP applied in the block that produced this tail.
    let mut written = [0_i16; 20];
    for (band, gain) in written.iter_mut().enumerate() {
        *gain = i16::try_from(band).expect("20 bands") * 16 - 96;
    }
    shim.set_params(session, &[("gebg", &written)]);
    let (_, vis) = shim.process(session, &sine_block(0, 44_100, 8000.0));
    let (_, gebg) = vis.split_at(vis.len() - 20);
    assert_eq!(gebg, written, "gebg slot == the write in force");
    shim.finish();
}

/// Slice 07's tracer bullet: `SetParams` lands in the live registry
/// (`GetParams` reads back the write), and an out-of-range write reads
/// back the engine's own clamp — `dvla` is `[0..10]` (probe §7), so
/// 200 → 10.
#[test]
fn set_params_reads_back_and_out_of_range_reads_the_clamp() {
    let mut shim = Shim::spawn("params_tracer");
    let session = shim.create(44_100);
    shim.set_params(session, &[("dvla", &[8])]);
    assert_eq!(shim.get_params(session, &["dvla"]), [[8]]);
    shim.set_params(session, &[("dvla", &[200])]);
    assert_eq!(
        shim.get_params(session, &["dvla"]),
        [[10]],
        "the registry holds the clamped value the DSP uses"
    );
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
        let (output, _) = shim.process(session, &input);
        last = (input, output);
    }
    assert_ne!(last.1, last.0, "enabled processing must not be identity");
    shim.finish();
}
