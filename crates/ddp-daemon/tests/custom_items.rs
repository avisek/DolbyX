//! Slice 18 part A behaviors (issue #26): custom profiles & EQ presets
//! over the wire — `add_*` from content with the server-minted id on
//! the ack, `edit_*` name patches, `remove_*` with the referential
//! fallbacks — all on the 18a content grammar (ADR-0005). Stub backend
//! (mock policy) — behavior 8 replays the flow in `e2e_qemu.rs`.

mod common;

use common::{
    assert_config_becomes, connected, recv_json, send_json, set_params_batches, start_daemon,
    start_over, try_recv_json, ws_connect,
};
use serde_json::json;

/// Sends `command` and awaits its `ack`, returning the minted `id`
/// carried on `add_*` acks (ADR-0005: replies settle promise-style).
async fn ack_of(ws: &mut common::WsClient, command: &serde_json::Value) -> serde_json::Value {
    send_json(ws, command).await;
    let reply = recv_json(ws).await;
    assert_eq!(reply["type"], "ack", "expected an ack, got {reply}");
    assert_eq!(reply["request_id"], command["request_id"]);
    reply["id"].clone()
}

/// Behavior 2 (issue #26 A), the slice's entry tracer: `add_profile`
/// with content copied from Music's resolved snapshot → a fresh
/// `user_<hash>` on the ack, no engine call (the daemon never moves
/// selection on add), and — switched to — the clone sounds identical
/// to Music: its full resolved batch is byte-for-byte Music's.
#[tokio::test]
async fn add_profile_with_musics_content_mints_an_id_and_sounds_identical() {
    let daemon = start_daemon().await;
    daemon
        .handle
        .supervisor()
        .create_session(48000)
        .expect("session");
    let mut originator = connected(daemon.addr()).await;
    let mut other = connected(daemon.addr()).await;

    // The UI clone gesture (ADR-0005): copy the resolved content the
    // client already holds — no source reference on the wire.
    send_json(
        &mut originator,
        &json!({ "cmd": "get_state", "request_id": "r1" }),
    )
    .await;
    let snapshot = recv_json(&mut originator).await["snapshot"].take();
    assert_eq!(snapshot["profiles"][1]["id"], "music");
    let music_params = snapshot["profiles"][1]["params"].clone();

    let minted = ack_of(
        &mut originator,
        &json!({ "cmd": "add_profile", "request_id": "r2", "name": "Music 2", "params": music_params }),
    )
    .await;
    let minted = minted.as_str().expect("add_profile ack carries the id");
    assert!(
        minted.starts_with("user_")
            && minted.len() == 9
            && minted[5..].chars().all(|c| c.is_ascii_hexdigit()),
        "server-minted `user_<hash>`, got {minted:?}"
    );
    assert_eq!(
        set_params_batches(&daemon.stub).len(),
        1,
        "init only — an add never touches the engine"
    );

    // The other client hears the add via broadcast, factory first.
    let broadcast = recv_json(&mut other).await;
    assert_eq!(broadcast["type"], "state");
    let clone = &broadcast["snapshot"]["profiles"][4];
    assert_eq!(clone["id"], minted);
    assert_eq!(clone["name"], "Music 2");
    assert_eq!(clone["is_factory"], false);
    assert_eq!(clone["selected_eq_preset"], serde_json::Value::Null);
    assert_eq!(clone["params"], snapshot["profiles"][1]["params"]);

    // Sounds identical: switching to the clone batches exactly what
    // Music's session init batched.
    let _ = ack_of(
        &mut originator,
        &json!({ "cmd": "set_profile", "request_id": "r3", "id": minted }),
    )
    .await;
    let batches = set_params_batches(&daemon.stub);
    assert_eq!(batches.len(), 2, "init + the switch");
    assert_eq!(batches[1], batches[0], "the clone is Music, value for value");
}

/// Behavior 2 (issue #26 A), partial half: unstated `add_profile`
/// params resolve from the **custom baseline** (`ParameterDef.default`
/// ⊕ shared layers) — not from any factory profile's own values.
#[tokio::test]
async fn add_profile_partial_params_resolve_from_the_custom_baseline() {
    let daemon = start_daemon().await;
    let mut ws = connected(daemon.addr()).await;

    let minted = ack_of(
        &mut ws,
        &json!({ "cmd": "add_profile", "request_id": "r1", "name": "Bass", "params": { "dvla": [9] } }),
    )
    .await;
    send_json(&mut ws, &json!({ "cmd": "get_state", "request_id": "r2" })).await;
    let snapshot = recv_json(&mut ws).await["snapshot"].take();
    let custom = &snapshot["profiles"][4];
    assert_eq!(custom["id"], minted);
    assert_eq!(custom["params"]["dvla"], json!([9]), "the stated param");
    assert_eq!(
        custom["params"]["genb"],
        json!([20]),
        "the defaults [profile] shared layer applies"
    );
    assert_eq!(
        custom["params"]["deon"], json!([0]),
        "ParameterDef.default — not Music's deon = 1"
    );
    assert_eq!(
        custom["params"]["dvle"], json!([1]),
        "ParameterDef.default — not Music's dvle = 0"
    );
}

/// Behavior 2 (issue #26 A), preset half: `add_eq_preset` from content
/// mints an id; unstated params resolve from the custom baseline (the
/// `[eq_preset]` shared band structure over `ParameterDef.default` —
/// `ieon` stays 0, nothing inherits a factory preset's row); a profile
/// can select the fresh preset at once.
#[tokio::test]
async fn add_eq_preset_mints_an_id_and_is_selectable() {
    let daemon = start_daemon().await;
    daemon
        .handle
        .supervisor()
        .create_session(48000)
        .expect("session");
    let mut ws = connected(daemon.addr()).await;

    let minted = ack_of(
        &mut ws,
        &json!({ "cmd": "add_eq_preset", "request_id": "r1", "name": "My Rich", "params": { "iebt": [67, 95], "ieon": [1] } }),
    )
    .await;
    let minted = minted.as_str().expect("add_eq_preset ack carries the id");
    assert!(minted.starts_with("user_"), "got {minted:?}");

    send_json(&mut ws, &json!({ "cmd": "get_state", "request_id": "r2" })).await;
    let snapshot = recv_json(&mut ws).await["snapshot"].take();
    let preset = &snapshot["eq_presets"][3];
    assert_eq!(preset["id"], minted);
    assert_eq!(preset["name"], "My Rich");
    assert_eq!(preset["is_factory"], false);
    assert_eq!(preset["params"]["iebt"][0], 67);
    assert_eq!(preset["params"]["iebt"][1], 95);
    assert_eq!(preset["params"]["ieon"], json!([1]), "the stated enable");
    assert_eq!(
        preset["params"]["genb"],
        json!([20]),
        "the [eq_preset] shared band structure applies"
    );
    assert_eq!(
        preset["params"]["iea"], json!([10]),
        "ParameterDef.default — no factory preset row leaks in"
    );

    // Selecting the fresh preset overlays it — the engine hears the
    // resolved nine with the custom curve.
    let _ = ack_of(
        &mut ws,
        &json!({ "cmd": "edit_profile", "request_id": "r3", "id": "music", "selected_eq_preset": minted }),
    )
    .await;
    let batches = set_params_batches(&daemon.stub);
    let batch: std::collections::HashMap<&str, &[i16]> = batches
        .last()
        .expect("the selection flushes")
        .iter()
        .map(|(name, values)| (name.as_str(), values.as_slice()))
        .collect();
    assert_eq!(batch["iebt"][..2], [67, 95]);
    assert_eq!(batch["ieon"], [1]);
}

/// `add_*` validation (epic validation section): empty-after-trim
/// names, undeclared/read-only/out-of-range params, non-preset-carried
/// preset params, and an unknown `selected_eq_preset` are
/// `INVALID_REQUEST` — nothing lands, the engine is never called.
#[tokio::test]
async fn add_validation_failures_are_invalid_request() {
    let daemon = start_daemon().await;
    let mut ws = connected(daemon.addr()).await;

    for (request, needle) in [
        (
            json!({ "cmd": "add_profile", "request_id": "r1", "name": "   " }),
            "empty",
        ),
        (
            json!({ "cmd": "add_profile", "request_id": "r2", "name": "X", "params": { "dvla": [11] } }),
            "outside",
        ),
        (
            json!({ "cmd": "add_profile", "request_id": "r3", "name": "X", "params": { "vnnb": [5] } }),
            "read-only",
        ),
        (
            json!({ "cmd": "add_profile", "request_id": "r4", "name": "X", "selected_eq_preset": "ghost" }),
            "unknown EQ preset",
        ),
        (
            json!({ "cmd": "add_eq_preset", "request_id": "r5", "name": "X", "params": { "dvla": [4] } }),
            "not preset-carried",
        ),
        (
            json!({ "cmd": "add_eq_preset", "request_id": "r6", "name": "\t " }),
            "empty",
        ),
    ] {
        send_json(&mut ws, &request).await;
        let error = recv_json(&mut ws).await;
        assert_eq!(error["type"], "error", "{request}");
        assert_eq!(error["code"], "INVALID_REQUEST");
        assert_eq!(error["request_id"], request["request_id"]);
        assert!(
            error["message"].as_str().expect("message").contains(needle),
            "wanted {needle:?} in {error}"
        );
    }
    assert!(daemon.stub.calls().is_empty());

    send_json(&mut ws, &json!({ "cmd": "get_state", "request_id": "r7" })).await;
    let snapshot = recv_json(&mut ws).await["snapshot"].take();
    assert_eq!(snapshot["profiles"].as_array().expect("array").len(), 4);
    assert_eq!(snapshot["eq_presets"].as_array().expect("array").len(), 3);
}
