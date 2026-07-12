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
/// proven Android stubs from `tools/ddp_probe`, once per test run —
/// the directory [`crate::QemuBackend::start`] takes.
///
/// # Panics
///
/// When any build/staging step fails — the suite cannot run without
/// the real engine.
pub fn staged_engine_dir() -> &'static Path {
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
