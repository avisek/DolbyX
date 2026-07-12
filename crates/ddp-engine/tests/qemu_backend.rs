//! Slice 08 backend suite (#16): `QemuBackend` against the real
//! engine — one-subprocess multiplexing, host-side validation, and
//! crash + lazy respawn. (The supervisor's session replay on top of
//! this lives in `ddp-daemon`'s e2e suite.)
//!
//! Feature-gated `qemu`; prerequisites as in
//! `ddp_engine::test_support`.
#![cfg(feature = "qemu")]

use ddp_engine::test_support::staged_engine_dir;
use ddp_engine::{Engine, EngineError, QemuBackend};

fn start_backend() -> QemuBackend {
    QemuBackend::start(staged_engine_dir()).expect("engine starts")
}

/// SIGKILLs the engine subprocess — the crash the backend must absorb.
fn kill(pid: u32) {
    let status = std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .status()
        .expect("kill runs");
    assert!(status.success(), "kill -9 {pid}: {status}");
}

/// Behavior 1 (issue #16): `start` spawns exactly one subprocess and
/// every session multiplexes onto it.
#[test]
fn one_subprocess_multiplexes_every_session() {
    let backend = start_backend();
    let pid = backend.pid().expect("live subprocess");
    let a = backend.create_session(44_100).unwrap();
    let b = backend.create_session(48_000).unwrap();
    assert_ne!(a, b, "ids are independent");
    assert_eq!(backend.pid(), Some(pid), "one process serves both");

    // Both sessions answer independently on the shared process — the
    // engine version reads back, and registries never cross.
    assert_eq!(backend.get_params(a, &["ver"]).unwrap(), [[2, 0, 4, 0]]);
    backend.set_params(a, &[("dvla", &[3_i16][..])]).unwrap();
    assert_eq!(backend.get_params(a, &["dvla"]).unwrap(), [[3]]);
    assert_eq!(
        backend.get_params(b, &["dvla"]).unwrap(),
        [[7]],
        "the sibling keeps its power-on registry"
    );
}

/// Behavior 3 (issue #16): footgun configs are rejected host-side with
/// `UnsupportedConfig` — the shim path would answer `Rejected` — so
/// the engine never sees them, and the subprocess keeps serving.
#[test]
fn footgun_configs_never_reach_the_engine() {
    let backend = start_backend();
    let pid = backend.pid();

    let error = backend.create_session(96_000).unwrap_err();
    assert!(
        matches!(error, EngineError::UnsupportedConfig(_)),
        "{error}"
    );

    let session = backend.create_session(44_100).unwrap();
    let mut mono = [0_i16; 3];
    let error = backend
        .process(session, &[0_i16; 3], &mut mono)
        .unwrap_err();
    assert!(
        matches!(error, EngineError::UnsupportedConfig(_)),
        "{error}"
    );

    // Untouched by the rejections: same process, still processing.
    assert_eq!(backend.pid(), pid);
    let mut output = [0_i16; 4];
    backend
        .process(session, &[1, 2, 3, 4], &mut output)
        .unwrap();
    assert_eq!(output, [1, 2, 3, 4], "never-enabled ⇒ dry deposit");
}

/// The backend hides the subprocess lifecycle: a kill surfaces
/// `Crashed` on the call that hits it (sessions died with the
/// process), and the next call respawns onto a fresh process.
#[test]
fn a_killed_subprocess_respawns_on_the_next_call() {
    let backend = start_backend();
    let session = backend.create_session(44_100).unwrap();
    kill(backend.pid().expect("live subprocess"));

    let error = backend.set_enabled(session, true).unwrap_err();
    assert!(matches!(error, EngineError::Crashed(_)), "{error}");
    assert_eq!(backend.pid(), None, "reaped on detection");

    // The next call brings a fresh process up; the old session id died
    // with the old one.
    let fresh = backend.create_session(48_000).unwrap();
    assert!(backend.pid().is_some(), "respawned lazily");
    let mut output = [0_i16; 4];
    backend.process(fresh, &[5, 6, 7, 8], &mut output).unwrap();
    assert_eq!(output, [5, 6, 7, 8]);
}
