//! Slice 11 (#19): `AudioServer` + plugin protocol over the real
//! platform socket (`AF_UNIX` here, the named pipe on the Windows
//! runner — behavior 1 rides every test). Mock policy: real socket
//! both platforms, stub engine (its marker contract: enabled → bitwise
//! NOT, disabled → echo); the real-engine replay lives in
//! `e2e_qemu.rs`.

mod common;

use std::sync::Arc;

use common::plugin::SyntheticPlugin;
use common::{connected, recv_json, set_power, socket_path_for, start_daemon};
use ddp_engine::{Call, Engine, EngineError, SessionId, StubBackend};
use serde_json::json;

/// One deterministic interleaved-stereo test tone; `seed` keeps two
/// plugins' tones distinct.
fn tone(seed: i16) -> Vec<i16> {
    (0..64).map(|i| seed.wrapping_mul(i)).collect()
}

/// The stub's marker transform — what an enabled session returns.
fn marked(pcm: &[i16]) -> Vec<i16> {
    pcm.iter().map(|sample| !sample).collect()
}

/// Polls `condition` (up to 3 s) until it holds — the assertion
/// primitive for cleanup the daemon performs after a disconnect it
/// notices asynchronously.
async fn wait_until(condition: impl Fn() -> bool, what: &str) {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
    while !condition() {
        assert!(tokio::time::Instant::now() < deadline, "timed out: {what}");
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

/// Behavior 1: the daemon binds the platform socket — the Unix socket
/// on Linux, the named pipe on Windows — and a plugin connects over
/// it. The production default is the epic's platform address.
#[tokio::test]
async fn the_daemon_binds_the_platform_socket() {
    let daemon = start_daemon().await;
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileTypeExt;
        let socket_type = std::fs::metadata(daemon.socket_path())
            .expect("socket file exists")
            .file_type();
        assert!(socket_type.is_socket(), "the bound path is a socket");
        assert_eq!(
            ddp_daemon::platform::DEFAULT_SOCKET_PATH,
            "/run/dolbyx/dolbyx.sock"
        );
    }
    #[cfg(windows)]
    assert_eq!(
        ddp_daemon::platform::DEFAULT_SOCKET_PATH,
        r"\\.\pipe\DolbyX"
    );

    // Proof of service, not just of binding: a plugin round-trips.
    let mut plugin = SyntheticPlugin::connect(&daemon.socket_path()).await;
    plugin.hello(48_000, 512).await;
}

/// Behavior 2: `Hello {48000, 512}` is acked with a fresh session id,
/// and the engine session was created at 48000 — the plugin's rate,
/// never a 44.1 fallback (pitch preserved).
#[tokio::test]
async fn hello_creates_an_engine_session_at_the_plugins_rate() {
    let daemon = start_daemon().await;
    let mut plugin = SyntheticPlugin::connect(&daemon.socket_path()).await;
    let session = plugin.hello(48_000, 512).await;
    assert_eq!(session, 0, "session ids mint fresh from 0");
    assert!(
        daemon.stub.calls().contains(&Call::CreateSession {
            sample_rate: 48_000,
            id: SessionId(0),
        }),
        "the engine session runs at the plugin's rate"
    );

    let mut second = SyntheticPlugin::connect(&daemon.socket_path()).await;
    assert_eq!(second.hello(44_100, 256).await, 1, "each Hello a fresh id");
}

/// Behavior 3: `Process` frames round-trip — power on transforms
/// (processed PCM ≠ input), power off bypasses (`OUT == IN`).
#[tokio::test]
async fn process_round_trips_and_power_off_bypasses() {
    let daemon = start_daemon().await;
    let mut plugin = SyntheticPlugin::connect(&daemon.socket_path()).await;
    plugin.hello(48_000, 512).await;

    let tone = tone(3);
    let processed = plugin.process(&tone).await;
    assert_eq!(
        processed,
        marked(&tone),
        "power on ⇒ ferried through the engine"
    );
    assert_ne!(processed, tone, "processed PCM ≠ input");

    let mut ws = connected(daemon.addr()).await;
    set_power(&mut ws, false).await;
    assert_eq!(plugin.process(&tone).await, tone, "power off ⇒ OUT == IN");
}

/// Behavior 4: two synthetic plugins multiplex over the one shared
/// engine — distinct sessions, and each hears its own tone back
/// (distinct test tones stay distinct, no crosstalk).
#[tokio::test]
async fn two_plugins_multiplex_without_crosstalk() {
    let daemon = start_daemon().await;
    let mut a = SyntheticPlugin::connect(&daemon.socket_path()).await;
    let mut b = SyntheticPlugin::connect(&daemon.socket_path()).await;
    let session_a = a.hello(48_000, 512).await;
    let session_b = b.hello(44_100, 512).await;
    assert_ne!(session_a, session_b, "distinct sessions");

    let (tone_a, tone_b) = (tone(3), tone(11));
    for _ in 0..3 {
        assert_eq!(a.process(&tone_a).await, marked(&tone_a), "a hears a");
        assert_eq!(b.process(&tone_b).await, marked(&tone_b), "b hears b");
    }
}

/// Behavior 5: `Goodbye` destroys the session; so does an abrupt
/// disconnect.
#[tokio::test]
async fn goodbye_and_abrupt_disconnect_destroy_the_session() {
    let daemon = start_daemon().await;
    let mut a = SyntheticPlugin::connect(&daemon.socket_path()).await;
    let mut b = SyntheticPlugin::connect(&daemon.socket_path()).await;
    let session_a = SessionId(a.hello(48_000, 512).await);
    let session_b = SessionId(b.hello(44_100, 512).await);

    a.goodbye().await;
    let stub = daemon.stub.clone();
    wait_until(
        move || stub.calls().contains(&Call::DestroySession(session_a)),
        "Goodbye destroys the session",
    )
    .await;

    drop(b); // no Goodbye — the host crashed / killed the plugin
    let stub = daemon.stub.clone();
    wait_until(
        move || stub.calls().contains(&Call::DestroySession(session_b)),
        "abrupt disconnect destroys the session",
    )
    .await;
    assert_eq!(
        daemon.handle.supervisor().main_session(),
        None,
        "zero plugins ⇒ zero sessions"
    );
}

/// Behavior 6: kill the oldest plugin → the next-oldest becomes the
/// main session, the readouts re-read from it, and a fresh snapshot
/// broadcasts to WS clients.
#[tokio::test]
async fn main_session_handover_rereads_readouts_and_broadcasts() {
    let dir = common::fixture_dir();
    // Sessions power on reading vnnb [0], like the real engine.
    let stub = Arc::new(StubBackend::seeded(vec![("vnnb".into(), vec![0])]));
    let daemon = common::start_with(&dir, stub.clone()).await;
    let socket = socket_path_for(&dir);

    let mut a = SyntheticPlugin::connect(&socket).await;
    let mut b = SyntheticPlugin::connect(&socket).await;
    a.hello(48_000, 512).await;
    let session_b = b.hello(44_100, 512).await;
    // Sharpen b's registry so the handover is observable: [7] matches
    // neither a's power-on [0] nor the table default [20].
    stub.set_params(SessionId(session_b), &[("vnnb", &[7])])
        .unwrap();

    let mut ws = connected(daemon.addr()).await;
    a.goodbye().await;

    let event = recv_json(&mut ws).await;
    assert_eq!(event["type"], "state", "the handover broadcasts");
    assert_eq!(
        event["snapshot"]["readouts"]["vnnb"],
        json!([7]),
        "readouts re-read from the new main session"
    );
    assert_eq!(
        daemon.supervisor().main_session(),
        Some(SessionId(session_b)),
        "next-oldest took over"
    );
    daemon.shutdown().await;
}

/// Behavior 7: toggling power fans `set_enabled` to every live plugin
/// session — audibly (bypass) and on the engine; a session created
/// while power is off starts disabled.
#[tokio::test]
async fn power_fans_out_to_every_plugin_and_gates_new_sessions() {
    let daemon = start_daemon().await;
    let mut a = SyntheticPlugin::connect(&daemon.socket_path()).await;
    let mut b = SyntheticPlugin::connect(&daemon.socket_path()).await;
    let session_a = SessionId(a.hello(48_000, 512).await);
    let session_b = SessionId(b.hello(44_100, 512).await);

    let mut ws = connected(daemon.addr()).await;
    set_power(&mut ws, false).await;
    let tone = tone(5);
    assert_eq!(a.process(&tone).await, tone, "a bypasses");
    assert_eq!(b.process(&tone).await, tone, "b bypasses");
    let disables: Vec<Call> = daemon
        .stub
        .calls()
        .into_iter()
        .filter(|call| matches!(call, Call::SetEnabled(_, false)))
        .collect();
    assert_eq!(
        disables,
        vec![
            Call::SetEnabled(session_a, false),
            Call::SetEnabled(session_b, false),
        ],
        "the toggle reached every live session"
    );

    let mut c = SyntheticPlugin::connect(&daemon.socket_path()).await;
    let session_c = SessionId(c.hello(48_000, 512).await);
    assert_eq!(c.process(&tone).await, tone, "born disabled ⇒ bypass");
    assert!(
        daemon
            .stub
            .calls()
            .contains(&Call::SetEnabled(session_c, false)),
        "created while power off ⇒ init ends disabled"
    );
}

/// Behavior 8: an invalid `Hello` rate is rejected cleanly — a
/// `Goodbye`, the connection closed, and the daemon healthy. The stub
/// accepts any rate, so the test plans the `UnsupportedConfig` the
/// `QemuBackend`'s host-side validation (Slice 08) raises.
#[tokio::test]
async fn an_invalid_hello_rate_is_rejected_cleanly() {
    let daemon = start_daemon().await;
    daemon.stub.fail_next(EngineError::UnsupportedConfig(
        "sample rate 96000 outside the engine's {44100, 48000, 32000}".into(),
    ));

    let plugin = SyntheticPlugin::connect(&daemon.socket_path()).await;
    plugin.hello_rejected(96_000, 512).await;

    // The daemon is healthy: no session leaked, and the next plugin
    // connects and processes.
    assert!(daemon.stub.calls().is_empty(), "nothing was created");
    let mut ok = SyntheticPlugin::connect(&daemon.socket_path()).await;
    ok.hello(48_000, 512).await;
    let tone = tone(9);
    assert_eq!(ok.process(&tone).await, marked(&tone));
}

/// Protocol discipline: a first message that isn't `Hello`, and a
/// block past the plugin's own `max_frames` promise, both end the
/// connection with a `Goodbye` — and the session, if any, dies with it.
#[tokio::test]
async fn protocol_violations_end_the_connection_cleanly() {
    use ddp_daemon::audio_server::PluginMessage;

    let daemon = start_daemon().await;
    let mut rogue = SyntheticPlugin::connect(&daemon.socket_path()).await;
    rogue
        .send(&PluginMessage::Process { pcm: vec![0, 0] })
        .await;
    rogue.expect_goodbye_and_close().await;
    assert!(daemon.stub.calls().is_empty(), "no session was created");

    let mut greedy = SyntheticPlugin::connect(&daemon.socket_path()).await;
    let session = SessionId(greedy.hello(48_000, 2).await);
    greedy
        .send(&PluginMessage::Process {
            pcm: vec![0; 6], // 3 frames — one past the promised 2
        })
        .await;
    greedy.expect_goodbye_and_close().await;
    assert!(
        daemon.stub.calls().contains(&Call::DestroySession(session)),
        "the violated session is destroyed"
    );
}
