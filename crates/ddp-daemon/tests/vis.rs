//! Slice 16 (#24): the event-driven visualizer feed on the wire — one
//! `vis` event per main-session block carrying the vis tail's four
//! arrays verbatim under 4-CC keys, to every WS client (no originator
//! rule). A pure event stream: no audio ⇒ no events, no timer, no
//! suspend flag anywhere (v1's 50 ms pump is dead). Mock policy: stub
//! fabricated frames here; the real-engine replay lives in
//! `e2e_qemu.rs`.

mod common;

use common::plugin::SyntheticPlugin;
use common::{connected, recv_json, start_daemon, try_recv_json};
use serde_json::json;

/// The stub's fabricated vis tail (`ddp_engine::stub::fabricated_vis`)
/// as the wire must carry it — four distinguishable ramps, keyed by
/// 4-CC.
fn fabricated_vis_event() -> serde_json::Value {
    let ramp = |base: i16| (base..base + 20).collect::<Vec<i16>>();
    json!({
        "type": "vis",
        "params": {
            "vnbg": ramp(0),
            "vnbe": ramp(20),
            "vcbg": ramp(40),
            "vcbe": ramp(60),
        }
    })
}

/// The tracer bullet + behaviors 1 and 3 (issue #24): every `process`
/// on the main session broadcasts exactly one `vis` event — the reply's
/// arrays verbatim — to every WS client; once the calls stop, the
/// stream is silent (idle is the client's to derive).
#[tokio::test]
async fn every_main_session_block_broadcasts_one_vis_event_to_every_client() {
    let daemon = start_daemon().await;
    let session = daemon
        .handle
        .supervisor()
        .create_session(48000)
        .expect("session");
    let mut a = connected(daemon.addr()).await;
    let mut b = connected(daemon.addr()).await;

    let mut output = [0_i16; 8];
    for _ in 0..3 {
        daemon
            .handle
            .supervisor()
            .process(session, &[0_i16; 8], &mut output)
            .expect("process");
    }

    // `vis` has no originator: both clients hear every block, in order.
    for ws in [&mut a, &mut b] {
        for _ in 0..3 {
            assert_eq!(recv_json(ws).await, fabricated_vis_event());
        }
    }

    // No audio ⇒ no events — nothing timed, nothing suspended.
    assert_eq!(try_recv_json(&mut a, 300).await, None);
}

/// Behaviors 2 + 4 (issue #24): a non-main session's blocks emit
/// nothing on the wire; when the main session dies the next-oldest
/// takes over as the source.
#[tokio::test]
async fn only_the_main_session_sources_vis_events() {
    let daemon = start_daemon().await;
    let supervisor = daemon.handle.supervisor();
    let main = supervisor.create_session(48000).expect("main session");
    let next = supervisor.create_session(44100).expect("second session");
    let mut ws = connected(daemon.addr()).await;

    let mut output = [0_i16; 8];
    supervisor
        .process(next, &[0_i16; 8], &mut output)
        .expect("process");
    assert_eq!(
        try_recv_json(&mut ws, 300).await,
        None,
        "a non-main session's blocks emit nothing"
    );

    supervisor.destroy_session(main).expect("destroy main");
    supervisor
        .process(next, &[0_i16; 8], &mut output)
        .expect("process");
    loop {
        let event = recv_json(&mut ws).await;
        // A handover may broadcast a snapshot first (readouts re-read).
        if event["type"] == "state" {
            continue;
        }
        assert_eq!(
            event,
            fabricated_vis_event(),
            "the next-oldest session became the vis source"
        );
        break;
    }
}

/// The production path: a plugin's `Process` block — not a supervisor
/// call — is what feeds the stream day to day.
#[tokio::test]
async fn a_plugin_block_feeds_the_vis_stream() {
    let daemon = start_daemon().await;
    let mut plugin = SyntheticPlugin::connect(&daemon.socket_path()).await;
    plugin.hello(48_000, 512).await;

    let mut ws = connected(daemon.addr()).await;
    plugin.process(&[0_i16; 64]).await;
    assert_eq!(recv_json(&mut ws).await, fabricated_vis_event());
}
