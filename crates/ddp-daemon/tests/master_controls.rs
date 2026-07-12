//! Slice 14 (issue #22), wire half: a master-control edit is an
//! ordinary `edit_profile` 1-entry batch — Slice 10 (#18) built the
//! path, these pin the three signature controls to it. Stub backend
//! (mock policy); behavior 9 replays against the real engine in
//! `e2e_qemu.rs`; the UI half lives in `ui/src/components/
//! MasterControls.test.tsx`.

mod common;

use common::{
    assert_config_becomes, connected, recv_json, send_json, set_params_batches, start_daemon,
    start_over, try_recv_json, ws_connect,
};
use serde_json::json;

/// The tracer bullet (issue #22): WS `edit_profile` carrying the Volume
/// Leveller amount on Music → the Stub records the 1-entry write, the
/// broadcast reaches the other client (originator suppressed —
/// behavior 7), `config.toml` persists it, and a restart reloads it
/// (behavior 6).
#[tokio::test]
async fn volume_leveller_amount_flows_stub_config_and_restart() {
    let daemon = start_daemon().await;
    daemon
        .handle
        .supervisor()
        .create_session(48000)
        .expect("session");
    let mut originator = connected(daemon.addr()).await;
    let mut other = connected(daemon.addr()).await;

    send_json(
        &mut originator,
        &json!({ "cmd": "edit_profile", "request_id": "r1", "id": "music", "params": { "dvla": [10] } }),
    )
    .await;
    assert_eq!(recv_json(&mut originator).await["type"], "ack");

    let batches = set_params_batches(&daemon.stub);
    assert_eq!(batches.len(), 2, "init + the edit — 1-entry, no dribble");
    assert_eq!(batches[1], vec![("dvla".to_string(), vec![10])]);

    let broadcast = recv_json(&mut other).await;
    assert_eq!(broadcast["type"], "state");
    assert_eq!(
        broadcast["snapshot"]["profiles"][1]["params"]["dvla"],
        json!([10]),
    );
    assert_eq!(
        try_recv_json(&mut originator, 300).await,
        None,
        "no state event for the originator"
    );

    let config = daemon.dir.path().join("data").join("config.toml");
    assert_config_becomes(&config, "[profile.music]\ndvla = 10\n").await;

    drop((originator, other));
    daemon.handle.shutdown().await;
    let (restarted, _stub) = start_over(&daemon.dir).await;
    let mut ws = ws_connect(restarted.addr()).await;
    let snapshot = recv_json(&mut ws).await;
    assert_eq!(
        snapshot["snapshot"]["profiles"][1]["params"]["dvla"],
        json!([10]),
        "the master-control edit survives the restart"
    );
}

/// Behaviors 2 + 4 (issue #22), wire half: each enable write is its own
/// 1-entry batch, and `vdhe`'s tristate tops out at the UI's on-value
/// `2` — `3` fails the table's range up front.
#[tokio::test]
async fn enable_writes_are_single_batches_and_vdhe_tops_out_at_two() {
    let daemon = start_daemon().await;
    daemon
        .handle
        .supervisor()
        .create_session(48000)
        .expect("session");
    let mut ws = connected(daemon.addr()).await;

    send_json(
        &mut ws,
        &json!({ "cmd": "edit_profile", "request_id": "r1", "id": "music", "params": { "dvle": [1] } }),
    )
    .await;
    assert_eq!(recv_json(&mut ws).await["type"], "ack");
    send_json(
        &mut ws,
        &json!({ "cmd": "edit_profile", "request_id": "r2", "id": "music", "params": { "vdhe": [0] } }),
    )
    .await;
    assert_eq!(recv_json(&mut ws).await["type"], "ack");

    let batches = set_params_batches(&daemon.stub);
    assert_eq!(batches.len(), 3, "init + one batch per toggle");
    assert_eq!(batches[1], vec![("dvle".to_string(), vec![1])]);
    assert_eq!(batches[2], vec![("vdhe".to_string(), vec![0])]);

    send_json(
        &mut ws,
        &json!({ "cmd": "edit_profile", "request_id": "r3", "id": "music", "params": { "vdhe": [3] } }),
    )
    .await;
    let error = recv_json(&mut ws).await;
    assert_eq!(error["type"], "error");
    assert_eq!(error["code"], "INVALID_REQUEST");
    assert_eq!(
        set_params_batches(&daemon.stub).len(),
        3,
        "the rejected write never reaches the engine"
    );
}
