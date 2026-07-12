//! `qemu`-feature test harness support: one staged real-engine
//! directory shared by every suite that drives `libdseffect.so`
//! (this crate's smoke + backend tests, `ddp-daemon`'s e2e suite).
//!
//! Prerequisites: `apt install gcc-arm-linux-gnueabihf
//! g++-arm-linux-gnueabihf qemu-user-static` plus `rustup target add
//! armv7-unknown-linux-gnueabihf` (`just qemu-test` provisions the
//! Rust side and runs the suites).

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;
use std::sync::OnceLock;

/// Builds the ARM shim and stages it beside `libdseffect.so` + the
/// proven Android stubs (`scripts/stage-engine.sh` — shared with `just
/// stage-engine`), once per test run — the directory
/// [`crate::QemuBackend::start`] takes.
///
/// # Panics
///
/// When staging fails — the suite cannot run without the real engine.
pub fn staged_engine_dir() -> &'static Path {
    static STAGE: OnceLock<PathBuf> = OnceLock::new();
    STAGE.get_or_init(|| {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(2)
            .expect("workspace root")
            .to_path_buf();
        let stage = root.join("target/qemu-stage");
        let status = ProcessCommand::new(root.join("scripts/stage-engine.sh"))
            .arg(&stage)
            .current_dir(&root)
            .status()
            .unwrap_or_else(|error| panic!("spawn stage-engine.sh: {error}"));
        assert!(status.success(), "stage-engine.sh failed: {status}");
        fs::create_dir_all(stage.join("logs")).expect("create log dir");
        stage
    })
}

/// SIGKILLs the engine subprocess — the crash the crash-recovery
/// suites inject.
///
/// # Panics
///
/// When `kill` cannot run or reports failure.
pub fn kill_engine(pid: u32) {
    let status = ProcessCommand::new("kill")
        .args(["-9", &pid.to_string()])
        .status()
        .expect("kill runs");
    assert!(status.success(), "kill -9 {pid}: {status}");
}
