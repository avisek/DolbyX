//! Shared harness (issue #21 mock policy): a real in-process daemon —
//! `StubBackend` behind the one sanctioned seam — on the real platform
//! socket, plus a synthetic VST2 host driving the exported entry.
//!
//! The plugin finds the daemon through the process-global
//! `DOLBYX_SOCKET_PATH`, so tests take turns: [`World`] holds a global
//! lock for its lifetime, and every env access happens inside it.

// Each tests/*.rs target compiles this module and uses a subset of it.
#![allow(dead_code)]

use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use ddp_daemon::{Daemon, DaemonConfig};
use ddp_engine::stub::Call;
use ddp_engine::{SessionId, StubBackend};
use ddp_vst_windows::vst2::{
    AEffect, AUDIO_MASTER_VERSION, EFF_CLOSE, EFF_MAINS_CHANGED, EFF_SET_SAMPLE_RATE, EFFECT_MAGIC,
    VST_VERSION,
};
use ddp_vst_windows::{pcm, vst_plugin_main};
use tempfile::TempDir;

/// A minimal stand-in for the built UI: exactly the placeholder
/// contract `ui/dev.html` ships.
pub const UI_HTML: &str =
    "<!doctype html>\n<html><head><!--BOOTSTRAP--></head><body></body></html>\n";

/// Serializes tests: the plugin's socket-address env var is one per
/// process.
static EXCLUSIVE: Mutex<()> = Mutex::new(());

/// One test's world: an exclusive daemon fixture the plugin's
/// transport is pointed at. Dropping it shuts the daemon down.
pub struct World {
    /// The injected recording backend.
    pub stub: Arc<StubBackend>,
    daemon: Option<Daemon>,
    runtime: tokio::runtime::Runtime,
    dir: TempDir,
    _lock: MutexGuard<'static, ()>,
}

impl World {
    /// A world with the daemon up and serving its plugin socket.
    pub fn start() -> Self {
        let mut world = Self::new();
        world.start_daemon();
        world
    }

    /// A world whose daemon hasn't started — the plugin's connects
    /// fail until [`Self::start_daemon`].
    pub fn start_without_daemon() -> Self {
        Self::new()
    }

    fn new() -> Self {
        let lock = EXCLUSIVE.lock().unwrap_or_else(PoisonError::into_inner);
        let dir = fixture_dir();
        // SAFETY: every access to this env var — this write and the
        // plugin transport's reads — happens with EXCLUSIVE held.
        unsafe { std::env::set_var("DOLBYX_SOCKET_PATH", socket_path_for(&dir)) };
        Self {
            stub: Arc::new(StubBackend::new()),
            daemon: None,
            runtime: tokio::runtime::Runtime::new().expect("tokio runtime"),
            dir,
            _lock: lock,
        }
    }

    /// Binds the daemon to this world's socket (also the restart half
    /// of the reconnect scenario — same address, fresh daemon).
    pub fn start_daemon(&mut self) {
        assert!(self.daemon.is_none(), "daemon already up");
        let config = DaemonConfig {
            port: 0,
            ui_path: self.dir.path().join("index.html"),
            daemon_dir: self.dir.path().to_path_buf(),
            config_dir: self.dir.path().join("data"),
            socket_path: socket_path_for(&self.dir),
        };
        let daemon = self
            .runtime
            .block_on(Daemon::start(config, self.stub.clone()))
            .expect("daemon starts");
        self.daemon = Some(daemon);
    }

    /// Stops the daemon — the in-process stand-in for the daemon
    /// process dying: connected plugins lose their stream (dropping
    /// the runtime ends the per-plugin serve tasks `Daemon::shutdown`
    /// leaves running), new connects fail fast.
    pub fn stop_daemon(&mut self) {
        let daemon = self.daemon.take().expect("daemon running");
        self.runtime.block_on(daemon.shutdown());
        let runtime = std::mem::replace(
            &mut self.runtime,
            tokio::runtime::Runtime::new().expect("tokio runtime"),
        );
        drop(runtime);
    }

    /// The engine session created at `sample_rate`, once it exists —
    /// rates disambiguate sessions across a test's plugins.
    pub fn session_at(&self, sample_rate: u32) -> SessionId {
        self.stub
            .calls()
            .into_iter()
            .find_map(|call| match call {
                Call::CreateSession {
                    sample_rate: rate,
                    id,
                } if rate == sample_rate => Some(id),
                _ => None,
            })
            .unwrap_or_else(|| panic!("no session was created at {sample_rate}"))
    }

    /// How many engine sessions have been created so far.
    pub fn sessions_created(&self) -> usize {
        self.stub
            .calls()
            .iter()
            .filter(|call| matches!(call, Call::CreateSession { .. }))
            .count()
    }
}

impl Drop for World {
    fn drop(&mut self) {
        if let Some(daemon) = self.daemon.take() {
            self.runtime.block_on(daemon.shutdown());
        }
    }
}

/// Writes a daemon dir fixture: the shipped `parameters.toml` +
/// `defaults.toml`, a placeholder UI file, and an empty config dir.
fn fixture_dir() -> TempDir {
    let dir = tempfile::tempdir().expect("create tempdir");
    let daemon_crate = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crates dir")
        .join("ddp-daemon");
    for shipped in ["parameters.toml", "defaults.toml"] {
        std::fs::copy(daemon_crate.join(shipped), dir.path().join(shipped))
            .unwrap_or_else(|e| panic!("copy shipped {shipped}: {e}"));
    }
    std::fs::write(dir.path().join("index.html"), UI_HTML).expect("write ui fixture");
    dir
}

/// The fixture's plugin socket address — the tempdir's unique name
/// keys the Windows pipe (pipes share one global namespace).
fn socket_path_for(dir: &TempDir) -> PathBuf {
    let unique = dir
        .path()
        .file_name()
        .expect("tempdir has a name")
        .to_string_lossy();
    if cfg!(windows) {
        format!(r"\\.\pipe\dolbyx-vst-{unique}").into()
    } else {
        dir.path().join("dolbyx.sock")
    }
}

/// Polls `condition` (up to 5 s) until it holds — for effects the
/// daemon lands asynchronously (session teardown after a `Goodbye`).
pub fn wait_until(condition: impl Fn() -> bool, what: &str) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !condition() {
        assert!(Instant::now() < deadline, "timed out: {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// A synthetic VST2 host holding one live plugin instance, driving it
/// through the same `AEffect` surface EqualizerAPO uses. Dropping it
/// dispatches `effClose`.
pub struct SyntheticHost {
    effect: *mut AEffect,
}

impl SyntheticHost {
    /// Calls the in-process (rlib-linked) entry and opens the instance.
    pub fn load() -> Self {
        Self::from_effect(vst_plugin_main(Some(host_callback)))
    }

    /// Adopts an `AEffect` some entry returned — the dlopen tracer
    /// drives the built cdylib's export through this — and opens it.
    pub fn from_effect(effect: *mut AEffect) -> Self {
        assert!(!effect.is_null(), "the entry returns an effect");
        let host = Self { effect };
        assert_eq!(host.aeffect().magic, EFFECT_MAGIC);
        host.dispatch(
            ddp_vst_windows::vst2::EFF_OPEN,
            0,
            0,
            std::ptr::null_mut(),
            0.0,
        );
        host
    }

    /// The live `AEffect` the entry minted.
    pub fn aeffect(&self) -> &AEffect {
        // SAFETY: minted by `load`, freed only by drop's effClose.
        unsafe { &*self.effect }
    }

    /// One dispatcher call, exactly as a host makes it.
    pub fn dispatch(
        &self,
        opcode: i32,
        index: i32,
        value: isize,
        ptr: *mut c_void,
        opt: f32,
    ) -> isize {
        let dispatcher = self.aeffect().dispatcher.expect("dispatcher set");
        // SAFETY: driving the plugin per the VST2 contract.
        unsafe { dispatcher(self.effect, opcode, index, value, ptr, opt) }
    }

    /// `effSetSampleRate`.
    pub fn set_sample_rate(&self, rate: f32) {
        self.dispatch(EFF_SET_SAMPLE_RATE, 0, 0, std::ptr::null_mut(), rate);
    }

    /// `effMainsChanged(1)`.
    pub fn resume(&self) {
        self.dispatch(EFF_MAINS_CHANGED, 0, 1, std::ptr::null_mut(), 0.0);
    }

    /// `effMainsChanged(0)`.
    pub fn suspend(&self) {
        self.dispatch(EFF_MAINS_CHANGED, 0, 0, std::ptr::null_mut(), 0.0);
    }

    /// One in-place `processReplacing` block (inputs == outputs —
    /// EqualizerAPO's shape): `left`/`right` are consumed as input and
    /// hold the output on return.
    pub fn process(&self, left: &mut [f32], right: &mut [f32]) {
        assert_eq!(left.len(), right.len(), "stereo halves match");
        let frames = i32::try_from(left.len()).expect("test blocks are small");
        let process = self
            .aeffect()
            .process_replacing
            .expect("processReplacing set");
        let inputs = [left.as_ptr(), right.as_ptr()];
        let outputs = [left.as_mut_ptr(), right.as_mut_ptr()];
        // SAFETY: both pointer arrays outlive the call and point at
        // `frames`-sample channels.
        unsafe {
            process(
                self.effect,
                inputs.as_ptr(),
                outputs.as_ptr().cast_mut(),
                frames,
            );
        }
    }
}

impl Drop for SyntheticHost {
    fn drop(&mut self) {
        self.dispatch(EFF_CLOSE, 0, 0, std::ptr::null_mut(), 0.0);
    }
}

/// A live VST2 host callback: answers the version probe.
pub unsafe extern "C" fn host_callback(
    _effect: *mut AEffect,
    opcode: i32,
    _index: i32,
    _value: isize,
    _ptr: *mut c_void,
    _opt: f32,
) -> isize {
    if opcode == AUDIO_MASTER_VERSION {
        VST_VERSION
    } else {
        0
    }
}

/// One deterministic stereo test block on the PCM16 grid (so the
/// float↔int conversion is exact end-to-end); `seed` keeps two
/// plugins' tones distinct.
pub fn tone(seed: i16, frames: usize) -> (Vec<f32>, Vec<f32>) {
    let sample = |i: usize, channel: i16| {
        let index = i16::try_from(i % 128).expect("bounded");
        pcm::to_f32(seed.wrapping_mul(index).wrapping_add(channel))
    };
    (
        (0..frames).map(|i| sample(i, 0)).collect(),
        (0..frames).map(|i| sample(i, 1)).collect(),
    )
}

/// What an enabled engine session hands back for `samples` — the
/// stub's marker transform (bitwise NOT, issue #12's pinned contract)
/// seen through the plugin's float boundary.
pub fn marked(samples: &[f32]) -> Vec<f32> {
    samples
        .iter()
        .map(|&sample| pcm::to_f32(!pcm::to_i16(sample)))
        .collect()
}
