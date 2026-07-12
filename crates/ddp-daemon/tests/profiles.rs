//! Slice 10 behaviors (issue #18): profile switching, editing, and
//! reset over the wire; the cascade persisting through restart. Stub
//! backend (mock policy) — behavior 11 replays the flow in
//! `e2e_qemu.rs`.

mod common;

use common::{
    assert_config_becomes, connected, recv_json, send_json, start_daemon, start_over,
    try_recv_json, ws_connect,
};
use ddp_engine::Call;
use serde_json::json;

/// A profile's full resolved set, recomputed from the shipped files —
/// what one atomic switch batch must carry.
fn resolved(profile: &str) -> Vec<(String, Vec<i16>)> {
    let defs = ddp_state::parse(include_str!("../parameters.toml")).expect("table parses");
    let defaults = ddp_persistence::parse_defaults(include_str!("../defaults.toml"), &defs)
        .expect("defaults parse");
    let mut state = ddp_state::State::new_from_defaults(&defaults);
    state.selected_profile = ddp_state::ProfileId(profile.into());
    state.resolved_batch(&defs)
}

/// The recorded `set_params` batches, in issue order.
fn set_params_batches(stub: &ddp_engine::StubBackend) -> Vec<Vec<(String, Vec<i16>)>> {
    stub.calls()
        .into_iter()
        .filter_map(|call| match call {
            Call::SetParams(_, batch) => Some(batch),
            _ => None,
        })
        .collect()
}

/// The slice's tracer bullet (issue #18): WS `set_profile {id:"movie"}`
/// → the stub records a **single** `set_params` carrying Movie's full
/// resolved parameter set; the other client updates via broadcast.
#[tokio::test]
async fn tracer_bullet_set_profile_pushes_movies_full_set_in_one_batch() {
    let daemon = start_daemon().await;
    daemon
        .handle
        .supervisor()
        .create_session(48000)
        .expect("session");
    let mut originator = connected(daemon.addr()).await;
    let mut other = connected(daemon.addr()).await;

    // Session init already pushed the boot profile (Music) — the
    // reshape-at-init write.
    let batches = set_params_batches(&daemon.stub);
    assert_eq!(batches.len(), 1, "init pushes one batch");
    assert_eq!(batches[0], resolved("music"));

    send_json(
        &mut originator,
        &json!({ "cmd": "set_profile", "request_id": "r1", "id": "movie" }),
    )
    .await;
    let ack = recv_json(&mut originator).await;
    assert_eq!(ack["type"], "ack");
    assert_eq!(ack["request_id"], "r1");

    let batches = set_params_batches(&daemon.stub);
    assert_eq!(batches.len(), 2, "one atomic batch per switch — no dribble");
    let movie = resolved("movie");
    assert_eq!(batches[1], movie);
    assert_eq!(movie.len(), 52, "every writable param, none dropped");
    assert!(movie.contains(&("dvla".to_string(), vec![7])));
    assert!(movie.contains(&("genb".to_string(), vec![20])));

    // The other client hears the switch via broadcast; the originator's
    // feedback was its ack (originator-aware fan-out, ADR-0005).
    let broadcast = recv_json(&mut other).await;
    assert_eq!(broadcast["type"], "state");
    assert_eq!(broadcast["snapshot"]["selected_profile"], "movie");
    assert_eq!(
        try_recv_json(&mut originator, 300).await,
        None,
        "no state event for the originator"
    );
}

/// The snapshot carries the complete profiles — the UI renders tabs
/// and (later) controls straight from it.
#[tokio::test]
async fn the_snapshot_carries_the_four_complete_factory_profiles() {
    let daemon = start_daemon().await;
    let mut ws = ws_connect(daemon.addr()).await;
    let snapshot = recv_json(&mut ws).await;

    let profiles = snapshot["snapshot"]["profiles"]
        .as_array()
        .expect("profiles array");
    let names: Vec<(&str, &str)> = profiles
        .iter()
        .map(|profile| {
            (
                profile["id"].as_str().expect("id"),
                profile["name"].as_str().expect("name"),
            )
        })
        .collect();
    assert_eq!(
        names,
        [
            ("movie", "Movie"),
            ("music", "Music"),
            ("game", "Game"),
            ("voice", "Voice"),
        ],
    );
    for profile in profiles {
        assert_eq!(profile["is_factory"], true);
        assert_eq!(profile["selected_eq_preset"], serde_json::Value::Null);
    }
    assert_eq!(profiles[1]["params"]["dvla"], json!([4]), "music complete");
}

/// Behavior 5 (issue #18): `edit_profile` on the selected profile
/// flushes a 1-entry batch; on a non-selected profile it persists but
/// never touches the engine.
#[tokio::test]
async fn edit_profile_flushes_only_when_selected() {
    let daemon = start_daemon().await;
    daemon
        .handle
        .supervisor()
        .create_session(48000)
        .expect("session");
    let mut ws = connected(daemon.addr()).await;

    // Selected (music): the engine hears exactly the edited entry.
    send_json(
        &mut ws,
        &json!({ "cmd": "edit_profile", "request_id": "r1", "id": "music", "params": { "dvla": [5] } }),
    )
    .await;
    assert_eq!(recv_json(&mut ws).await["type"], "ack");
    let batches = set_params_batches(&daemon.stub);
    assert_eq!(batches.len(), 2, "init + the live edit");
    assert_eq!(batches[1], vec![("dvla".to_string(), vec![5])]);

    // Non-selected (movie): persisted, engine untouched.
    send_json(
        &mut ws,
        &json!({ "cmd": "edit_profile", "request_id": "r2", "id": "movie", "params": { "dea": [8] } }),
    )
    .await;
    assert_eq!(recv_json(&mut ws).await["type"], "ack");
    assert_eq!(
        set_params_batches(&daemon.stub).len(),
        2,
        "no engine call for a non-selected edit"
    );

    let config = daemon.dir.path().join("data").join("config.toml");
    assert_config_becomes(
        &config,
        "[profile.movie]\ndea = 8\n\n[profile.music]\ndvla = 5\n",
    )
    .await;
}

/// Behavior 6 (issue #18): the selection and per-profile edits survive
/// a restart; factory values never land in `config.toml`.
#[tokio::test]
async fn selection_and_edits_survive_a_restart() {
    let daemon = start_daemon().await;
    let mut ws = connected(daemon.addr()).await;

    send_json(
        &mut ws,
        &json!({ "cmd": "set_profile", "request_id": "r1", "id": "game" }),
    )
    .await;
    assert_eq!(recv_json(&mut ws).await["type"], "ack");
    send_json(
        &mut ws,
        &json!({ "cmd": "edit_profile", "request_id": "r2", "id": "music", "params": { "dvla": [9] } }),
    )
    .await;
    assert_eq!(recv_json(&mut ws).await["type"], "ack");

    // Exactly the divergences — nothing factory, nothing more.
    let config = daemon.dir.path().join("data").join("config.toml");
    assert_config_becomes(
        &config,
        "selected_profile = \"game\"\n\n[profile.music]\ndvla = 9\n",
    )
    .await;

    drop(ws);
    daemon.handle.shutdown().await;
    let (restarted, _stub) = start_over(&daemon.dir).await;
    let mut ws = ws_connect(restarted.addr()).await;
    let snapshot = recv_json(&mut ws).await;
    assert_eq!(snapshot["snapshot"]["selected_profile"], "game");
    let profiles = snapshot["snapshot"]["profiles"].as_array().expect("array");
    assert_eq!(profiles[1]["params"]["dvla"], json!([9]), "music edit kept");
    assert_eq!(profiles[0]["params"]["dvla"], json!([7]), "movie factory");
}

/// Behavior 8 (issue #18): `reset_profile` drops the profile's
/// `config.toml` overrides and broadcasts a fresh snapshot.
#[tokio::test]
async fn reset_profile_clears_overrides_and_broadcasts() {
    let daemon = start_daemon().await;
    let mut originator = connected(daemon.addr()).await;
    let mut other = connected(daemon.addr()).await;
    let config = daemon.dir.path().join("data").join("config.toml");

    send_json(
        &mut originator,
        &json!({ "cmd": "edit_profile", "request_id": "r1", "id": "music", "params": { "dvla": [9] } }),
    )
    .await;
    assert_eq!(recv_json(&mut originator).await["type"], "ack");
    assert_eq!(recv_json(&mut other).await["type"], "state");
    assert_config_becomes(&config, "[profile.music]\ndvla = 9\n").await;

    send_json(
        &mut originator,
        &json!({ "cmd": "reset_profile", "request_id": "r2", "id": "music" }),
    )
    .await;
    assert_eq!(recv_json(&mut originator).await["type"], "ack");

    let broadcast = recv_json(&mut other).await;
    assert_eq!(broadcast["type"], "state");
    assert_eq!(
        broadcast["snapshot"]["profiles"][1]["params"]["dvla"],
        json!([4]),
        "the fresh snapshot carries the factory value"
    );
    assert_config_becomes(&config, "").await;
}

/// Behavior 9 (issue #18): an unknown profile id → `INVALID_REQUEST`,
/// state unchanged, nothing broadcast.
#[tokio::test]
async fn set_profile_with_an_unknown_id_is_invalid_request() {
    let daemon = start_daemon().await;
    let mut ws = connected(daemon.addr()).await;
    let mut other = connected(daemon.addr()).await;

    send_json(
        &mut ws,
        &json!({ "cmd": "set_profile", "request_id": "r1", "id": "nonexistent" }),
    )
    .await;
    let error = recv_json(&mut ws).await;
    assert_eq!(error["type"], "error");
    assert_eq!(error["code"], "INVALID_REQUEST");
    assert_eq!(error["request_id"], "r1");
    assert!(
        error["message"]
            .as_str()
            .expect("message")
            .contains("nonexistent"),
        "the cause travels: {error}"
    );

    send_json(&mut ws, &json!({ "cmd": "get_state", "request_id": "r2" })).await;
    assert_eq!(
        recv_json(&mut ws).await["snapshot"]["selected_profile"],
        "music",
        "state unchanged"
    );
    assert_eq!(
        try_recv_json(&mut other, 300).await,
        None,
        "a rejected command broadcasts nothing"
    );
    assert!(
        daemon.stub.calls().is_empty(),
        "the engine is never called on validation failure"
    );
}

/// Param validation on the wire (epic validation section): out-of-range
/// and read-only writes are rejected up front — the engine clamps, so
/// the daemon is the only guard.
#[tokio::test]
async fn edit_profile_validation_failures_are_invalid_request() {
    let daemon = start_daemon().await;
    let mut ws = connected(daemon.addr()).await;

    for (request, needle) in [
        (
            json!({ "cmd": "edit_profile", "request_id": "r1", "id": "music", "params": { "dvla": [11] } }),
            "outside",
        ),
        (
            json!({ "cmd": "edit_profile", "request_id": "r2", "id": "music", "params": { "vnnb": [5] } }),
            "read-only",
        ),
        (
            json!({ "cmd": "edit_profile", "request_id": "r3", "id": "music", "params": { "mxou": [1] } }),
            "unknown parameter",
        ),
    ] {
        send_json(&mut ws, &request).await;
        let error = recv_json(&mut ws).await;
        assert_eq!(error["type"], "error");
        assert_eq!(error["code"], "INVALID_REQUEST");
        assert!(
            error["message"].as_str().expect("message").contains(needle),
            "wanted {needle:?} in {error}"
        );
    }
    assert!(daemon.stub.calls().is_empty());
}
