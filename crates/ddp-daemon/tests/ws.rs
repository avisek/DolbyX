//! Behaviors 2–3 (issue #12): WS `/ws` snapshot-on-connect; `set_power`
//! flips `State` and acks echoing `request_id`. Slice 18a (issue #57)
//! renovations: `ack` carries no `ok`; the total reply law — one
//! `request_id`-echoing reply per command, `get_state` answered by the
//! `state` event itself, broadcasts id-less.

mod common;

use common::{
    connected, recv_json, send_json, send_text, set_power, start_daemon, try_recv_json, ws_connect,
};
use ddp_engine::Call;
use serde_json::json;

#[tokio::test]
async fn the_first_ws_frame_is_a_state_event_matching_current_state() {
    let daemon = start_daemon().await;
    let mut ws = ws_connect(daemon.addr()).await;

    let event = recv_json(&mut ws).await;
    assert_eq!(event["type"], "state");
    assert_eq!(event["snapshot"]["power"], true);
    assert_eq!(event["snapshot"]["selected_profile"], "music");
    assert!(
        event.get("request_id").is_none(),
        "the connect snapshot is pub/sub — no request_id: {event}"
    );
}

#[tokio::test]
async fn set_power_flips_state_and_acks_the_request_id() {
    let daemon = start_daemon().await;
    let mut ws = ws_connect(daemon.addr()).await;
    let _connect_snapshot = recv_json(&mut ws).await;

    send_json(
        &mut ws,
        &json!({ "cmd": "set_power", "request_id": "r2", "on": false }),
    )
    .await;
    let ack = recv_json(&mut ws).await;
    assert_eq!(ack["type"], "ack");
    assert_eq!(ack["request_id"], "r2");
    // Behavior 3 (issue #57): `ok` is gone — it was never `false`,
    // `error` is the other arm.
    assert!(ack.get("ok").is_none(), "no ok field on an ack: {ack}");

    // Behavior 4 (issue #57): the `state` event itself answers
    // `get_state`, echoing the id — awaitable promise-style, no ack.
    send_json(&mut ws, &json!({ "cmd": "get_state", "request_id": "r3" })).await;
    let snapshot = recv_json(&mut ws).await;
    assert_eq!(snapshot["type"], "state");
    assert_eq!(snapshot["request_id"], "r3");
    assert_eq!(snapshot["snapshot"]["power"], false);
    assert_eq!(
        try_recv_json(&mut ws, 300).await,
        None,
        "exactly one reply per command — no trailing ack"
    );
}

/// The slice's tracer bullet (issue #12): WS → state → engine, with one
/// live session, lands `set_enabled(session, false)` on the stub
/// exactly once.
#[tokio::test]
async fn tracer_bullet_set_power_records_one_set_enabled_on_the_stub() {
    let daemon = start_daemon().await;
    let session = daemon
        .handle
        .supervisor()
        .create_session(48000)
        .expect("session");

    let mut ws = connected(daemon.addr()).await;
    set_power(&mut ws, false).await;

    let disables = daemon
        .stub
        .calls()
        .into_iter()
        .filter(|call| *call == Call::SetEnabled(session, false))
        .count();
    assert_eq!(disables, 1, "exactly one set_enabled(session, false)");
}

/// Behavior 5 (issue #12): the resulting `state` broadcast reaches every
/// connection except the originator (ADR-0005 — its `ack` confirms).
#[tokio::test]
async fn broadcast_reaches_the_other_client_but_not_the_originator() {
    let daemon = start_daemon().await;
    let mut originator = connected(daemon.addr()).await;
    let mut other = connected(daemon.addr()).await;

    set_power(&mut originator, false).await;

    let broadcast = recv_json(&mut other).await;
    assert_eq!(broadcast["type"], "state");
    assert_eq!(broadcast["snapshot"]["power"], false);
    assert!(
        broadcast.get("request_id").is_none(),
        "broadcasts are pub/sub — no request_id: {broadcast}"
    );

    assert_eq!(
        try_recv_json(&mut originator, 300).await,
        None,
        "the originator must not receive the state broadcast"
    );
}

/// Behavior 10 (issue #12): with zero sessions the snapshot's
/// `readouts` map carries the 8 ReadOnly-Static `ParameterDef.default`
/// values (real engine values arrive in Slice 08, #16).
#[tokio::test]
async fn zero_session_readouts_carry_the_parameter_defaults() {
    let daemon = start_daemon().await;
    let mut ws = ws_connect(daemon.addr()).await;
    let snapshot = recv_json(&mut ws).await;

    let readouts = snapshot["snapshot"]["readouts"]
        .as_object()
        .expect("readouts map");
    let mut names: Vec<&str> = readouts.keys().map(String::as_str).collect();
    names.sort_unstable();
    let mut expected = vec![
        "bndl", "bver", "lcmf", "lcpt", "lcvd", "ver", "vnbf", "vnnb",
    ];
    expected.sort_unstable();
    assert_eq!(names, expected, "exactly the 8 ReadOnly-Static params");

    // Literal anchor: the curated native-grid count at 44.1/48 kHz.
    assert_eq!(readouts["vnnb"], json!([20]));

    // And every value is the table's default, verbatim.
    let table = ddp_state::parse(include_str!("../parameters.toml"))
        .expect("table parses")
        .params;
    for (name, value) in readouts {
        let def = ddp_state::lookup(&table, name).expect("declared param");
        assert_eq!(value, &json!(def.default), "`{name}` readout");
    }
}

/// Behavior 5 (issue #16): with a live main session the snapshot's
/// `readouts` carry the engine's values; dead refs keep the defaults.
#[tokio::test]
async fn snapshot_readouts_prefer_the_main_sessions_live_values() {
    let dir = common::fixture_dir();
    let engine = std::sync::Arc::new(ddp_engine::StubBackend::seeded(vec![(
        "ver".into(),
        vec![9, 9, 9, 9],
    )]));
    let daemon = common::start_with(&dir, engine).await;
    daemon.supervisor().create_session(48000).expect("session");

    let mut ws = ws_connect(daemon.addr()).await;
    let readouts = recv_json(&mut ws).await["snapshot"]["readouts"].take();
    assert_eq!(readouts["ver"], json!([9, 9, 9, 9]), "live engine value");
    assert_eq!(
        readouts["vnnb"],
        json!([20]),
        "a dead ref falls back to the table default"
    );
    daemon.shutdown().await;
}

/// Behavior 9 (issue #12): malformed frames are answered, never fatal.
#[tokio::test]
async fn malformed_json_yields_invalid_request_without_dropping_the_connection() {
    let daemon = start_daemon().await;
    let mut ws = connected(daemon.addr()).await;

    send_text(&mut ws, "not json{{").await;
    let error = recv_json(&mut ws).await;
    assert_eq!(error["type"], "error");
    assert_eq!(error["code"], "INVALID_REQUEST");
    assert_eq!(error["request_id"], serde_json::Value::Null);

    // A structured frame carries its id even when the cmd is bogus —
    // promise-style clients must be able to settle the request.
    send_json(&mut ws, &json!({ "cmd": "warp_ten", "request_id": "r9" })).await;
    let error = recv_json(&mut ws).await;
    assert_eq!(error["type"], "error");
    assert_eq!(error["code"], "INVALID_REQUEST");
    assert_eq!(error["request_id"], "r9");

    // The connection survives and still serves commands.
    send_json(&mut ws, &json!({ "cmd": "get_state", "request_id": "r10" })).await;
    let snapshot = recv_json(&mut ws).await;
    assert_eq!(snapshot["type"], "state");
    assert_eq!(snapshot["request_id"], "r10");
}

/// Slice 08 (issue #16): an unrecoverable engine failure surfaces as an
/// `ENGINE_REJECTED` error — while state stays authoritative (the flip
/// is broadcast and replays onto the engine when it comes back) and the
/// connection keeps serving.
#[tokio::test]
async fn an_unrecoverable_engine_failure_surfaces_engine_rejected() {
    let dir = common::fixture_dir();
    let stub = std::sync::Arc::new(ddp_engine::StubBackend::new());
    let daemon = common::start_with(&dir, stub.clone()).await;
    daemon.supervisor().create_session(48000).expect("session");
    let mut originator = connected(daemon.addr()).await;
    let mut other = connected(daemon.addr()).await;

    stub.fail_forever(ddp_engine::EngineError::Crashed("engine gone".into()));
    send_json(
        &mut originator,
        &json!({ "cmd": "set_power", "request_id": "r1", "on": false }),
    )
    .await;
    let error = recv_json(&mut originator).await;
    assert_eq!(error["type"], "error");
    assert_eq!(error["code"], "ENGINE_REJECTED");
    assert_eq!(error["request_id"], "r1");
    assert!(
        error["message"]
            .as_str()
            .expect("message present")
            .contains("crashed"),
        "the cause travels on the wire: {error}"
    );
    assert!(
        error.get("status").is_none(),
        "a crash carries no engine status: {error}"
    );

    // State stayed authoritative: the other client got the flip.
    let broadcast = recv_json(&mut other).await;
    assert_eq!(broadcast["type"], "state");
    assert_eq!(broadcast["snapshot"]["power"], false);

    // The originator's connection survives and reflects the new state.
    send_json(
        &mut originator,
        &json!({ "cmd": "get_state", "request_id": "r2" }),
    )
    .await;
    assert_eq!(recv_json(&mut originator).await["snapshot"]["power"], false);
}

#[tokio::test]
async fn set_power_with_zero_sessions_makes_no_engine_call() {
    let daemon = start_daemon().await;
    let mut ws = connected(daemon.addr()).await;

    set_power(&mut ws, false).await;

    assert!(
        daemon.stub.calls().is_empty(),
        "state-only: no engine call with zero sessions"
    );
}
