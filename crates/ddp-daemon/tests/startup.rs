//! Behavior 11 (issue #12): the refuse-to-start policy at the process
//! level — missing UI HTML or malformed startup TOML exits nonzero with
//! a clear error naming the offending file.

mod common;

use std::path::Path;
use std::process::{Command, Output};

/// Runs a daemon binary to completion with the standard flags.
/// `--backend stub`: these tests exercise the TOML/UI refusals, and no
/// staged engine sits beside the test binary.
///
/// Retries `ETXTBSY`: a sibling test's fork can transiently inherit
/// [`copied_binary`]'s write-fd on this binary until its own exec
/// completes — execing meanwhile fails spuriously.
fn run(binary: &Path, ui: &Path, config_dir: &Path) -> Output {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let result = Command::new(binary)
            .args(["--backend", "stub", "--port", "0"])
            .arg("--ui")
            .arg(ui)
            .arg("--config-dir")
            .arg(config_dir)
            .output();
        match result {
            Err(error)
                if error.kind() == std::io::ErrorKind::ExecutableFileBusy
                    && std::time::Instant::now() < deadline =>
            {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            result => return result.expect("daemon binary runs"),
        }
    }
}

/// Asserts a startup refusal: nonzero exit, stderr naming `culprit`.
fn assert_refuses(output: &Output, culprit: &str) {
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        !output.status.success(),
        "must exit nonzero, got {} (stderr: {stderr})",
        output.status
    );
    assert!(
        stderr.contains("ddp-daemon:") && stderr.contains(culprit),
        "stderr must name {culprit}: {stderr}"
    );
}

#[test]
fn a_missing_ui_html_refuses_to_start() {
    let dir = common::fixture_dir();
    let output = run(
        Path::new(env!("CARGO_BIN_EXE_ddp-daemon")),
        &dir.path().join("no-such-ui.html"),
        &dir.path().join("data"),
    );
    assert_refuses(&output, "no-such-ui.html");
}

/// The binary resolves `parameters.toml`/`defaults.toml` beside itself,
/// so a copy of it in a fixture dir reads that dir's TOMLs.
fn copied_binary(dir: &Path) -> std::path::PathBuf {
    let copy = dir.join(if cfg!(windows) {
        "ddp-daemon.exe"
    } else {
        "ddp-daemon"
    });
    std::fs::copy(env!("CARGO_BIN_EXE_ddp-daemon"), &copy).expect("copy daemon binary");
    copy
}

#[test]
fn a_malformed_parameters_toml_refuses_to_start() {
    let dir = common::fixture_dir();
    std::fs::write(dir.path().join("parameters.toml"), "[[param]]\nname = 42\n")
        .expect("write broken table");
    let output = run(
        &copied_binary(dir.path()),
        &dir.path().join("index.html"),
        &dir.path().join("data"),
    );
    assert_refuses(&output, "parameters.toml");
}

#[test]
fn a_malformed_defaults_toml_refuses_to_start() {
    let dir = common::fixture_dir();
    std::fs::write(dir.path().join("defaults.toml"), "power = maybe\n")
        .expect("write broken defaults");
    let output = run(
        &copied_binary(dir.path()),
        &dir.path().join("index.html"),
        &dir.path().join("data"),
    );
    assert_refuses(&output, "defaults.toml");
}
