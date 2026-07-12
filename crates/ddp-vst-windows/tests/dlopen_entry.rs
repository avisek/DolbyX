//! The tracer bullet, by the letter (issue #21): load the built
//! cdylib, resolve `VSTPluginMain` from its export table, drive
//! resume → `processReplacing` with a sine — output ≠ input while the
//! daemon is up (Stub's marker transform), output == input (dry) when
//! it's down.

mod common;

use std::f32::consts::TAU;
use std::path::PathBuf;

use common::{SyntheticHost, World, host_callback, marked};
use ddp_vst_windows::vst2::{AEffect, AudioMasterCallback};

/// `VSTPluginMain`'s signature, as a host resolves it.
type EntryFn = unsafe extern "C" fn(AudioMasterCallback) -> *mut AEffect;

/// The uplifted cdylib beside the test binary:
/// `target/<profile>/deps/this-test` → `target/<profile>/<cdylib>`.
/// `cargo test` refreshes only the rlib the harness links, so build
/// the cdylib artifact first (a cached no-op when it's fresh).
fn cdylib_path() -> PathBuf {
    let mut build = std::process::Command::new(env!("CARGO"));
    build.args(["build", "-p", "ddp-vst-windows"]);
    if !cfg!(debug_assertions) {
        build.arg("--release");
    }
    let status = build.status().expect("cargo runs");
    assert!(status.success(), "the cdylib builds");

    let exe = std::env::current_exe().expect("test exe path");
    let profile = exe.parent().expect("deps dir").parent().expect("profile");
    let name = if cfg!(windows) {
        "ddp_vst_windows.dll"
    } else if cfg!(target_os = "macos") {
        "libddp_vst_windows.dylib"
    } else {
        "libddp_vst_windows.so"
    };
    profile.join(name)
}

/// One second's worth of a −6 dB 440 Hz sine at 48 kHz won't fit a
/// test — 64 frames of it will.
fn sine(frames: usize) -> Vec<f32> {
    (0..frames)
        .map(|i| {
            #[expect(clippy::cast_precision_loss, reason = "i < 64")]
            let phase = TAU * 440.0 * (i as f32) / 48_000.0;
            phase.sin() * 0.5
        })
        .collect()
}

#[test]
fn the_tracer_bullet_drives_the_cdylibs_exported_entry() {
    let mut world = World::start();
    // SAFETY: loading the cdylib this same build produced.
    let library = unsafe { libloading::Library::new(cdylib_path()) }.expect("the cdylib loads");
    // SAFETY: the symbol is the VST2 entry at its published signature.
    let entry: libloading::Symbol<'_, EntryFn> =
        unsafe { library.get(b"VSTPluginMain") }.expect("VSTPluginMain is in the export table");

    // SAFETY: calling the entry exactly as a VST2 host does.
    let host = SyntheticHost::from_effect(unsafe { entry(Some(host_callback)) });
    host.set_sample_rate(48_000.0);
    host.dispatch(
        ddp_vst_windows::vst2::EFF_SET_BLOCK_SIZE,
        0,
        64,
        std::ptr::null_mut(),
        0.0,
    );
    host.resume();

    let dry = sine(64);
    let (mut left, mut right) = (dry.clone(), dry.clone());
    host.process(&mut left, &mut right);
    assert_ne!(left, dry, "output ≠ input while the daemon is up");
    assert_eq!(left, marked(&dry), "…and it is exactly the engine marker");
    assert_eq!(right, marked(&dry));

    world.stop_daemon();
    let (mut left, mut right) = (dry.clone(), dry.clone());
    host.process(&mut left, &mut right);
    assert_eq!(left, dry, "output == input (dry) when it's down");
    assert_eq!(right, dry);

    drop(host); // effClose into still-loaded code, then the library
}
