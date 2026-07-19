//! Slice 18 behaviors (issue #26): custom profile & EQ preset CRUD
//! over the wire — minted-id acks, factory invariants, remove
//! fallbacks, persistence. Stub backend (mock policy); behavior 9
//! replays in `e2e_qemu.rs`.

mod common;

use std::collections::HashMap;

use common::{
    RICH_IEBT, assert_config_becomes, connected, recv_json, recv_state, send_json,
    set_params_batches, start_daemon, start_over, ws_connect,
};
use serde_json::json;

/// The nine EQ params — the preset-carried set, in the shipped table's
/// order.
const EQ_PARAMS: [&str; 9] = [
    "ienb", "iebf", "iebt", "ieon", "iea", "geon", "genb", "gebf", "gebg",
];

/// One recorded batch as a name-keyed map.
fn by_name(batch: &[(String, Vec<i16>)]) -> HashMap<&str, &[i16]> {
    batch
        .iter()
        .map(|(name, values)| (name.as_str(), values.as_slice()))
        .collect()
}

/// Issues `command` and returns the minted id off its ack.
async fn add(ws: &mut common::WsClient, command: &serde_json::Value) -> String {
    send_json(ws, command).await;
    let ack = recv_json(ws).await;
    assert_eq!(ack["type"], "ack", "add must ack, got {ack}");
    ack["id"].as_str().expect("minted id").to_string()
}

/// A rich clone's `config.toml` row: `name` plus its divergences from
/// the custom baseline — `iebt` (full 40-slot allocation) and `ieon`,
/// in table order.
fn rich_clone_row(id: &str, name: &str) -> String {
    let curve: Vec<String> = RICH_IEBT
        .iter()
        .map(ToString::to_string)
        .chain(std::iter::repeat_n("0".to_string(), 20))
        .collect();
    format!(
        "[eq_preset.{id}]\nname = \"{name}\"\niebt = [{}]\nieon = 1\n",
        curve.join(", ")
    )
}

/// The tracer bullet / behavior 2 (issue #26): `add_profile` clones
/// Music under a fresh `user_<hash>` id returned on the ack (`id` rides
/// `add_*` acks only), the broadcast snapshot carries the complete
/// clone (`is_factory` false), and the engine hears nothing.
#[tokio::test]
async fn tracer_bullet_add_profile_mints_an_id_on_the_ack() {
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
        &json!({ "cmd": "add_profile", "request_id": "r1", "from": "music", "name": "Late Night" }),
    )
    .await;
    let ack = recv_json(&mut originator).await;
    assert_eq!(ack["type"], "ack");
    assert_eq!(ack["request_id"], "r1");
    let id = ack["id"].as_str().expect("add_* acks carry the minted id");
    assert!(id.starts_with("user_"), "minted shape, got {id}");

    let broadcast = recv_json(&mut other).await;
    assert_eq!(broadcast["type"], "state");
    let profiles = broadcast["snapshot"]["profiles"].as_array().expect("array");
    assert_eq!(profiles.len(), 5, "the four factory profiles + the clone");
    let clone = &profiles[4];
    assert_eq!(clone["id"], id);
    assert_eq!(clone["name"], "Late Night");
    assert_eq!(clone["is_factory"], false);
    assert_eq!(clone["selected_eq_preset"], serde_json::Value::Null);
    assert_eq!(
        clone["params"], profiles[1]["params"],
        "music's resolved params, cloned"
    );
    assert_eq!(
        set_params_batches(&daemon.stub).len(),
        1,
        "init only — adding never touches the engine"
    );

    // A non-add ack stays bare: no `id` key.
    send_json(
        &mut originator,
        &json!({ "cmd": "set_power", "request_id": "r2", "on": false }),
    )
    .await;
    let ack = recv_json(&mut originator).await;
    assert_eq!(ack["type"], "ack");
    assert!(ack.get("id").is_none(), "`id` rides add_* acks only");
}

/// Behavior 3 (issue #26): rename updates `name` with the id — and so
/// the `[eq_preset.<id>]` persistence key — unchanged.
#[tokio::test]
async fn rename_updates_the_name_with_persistence_keys_stable() {
    let daemon = start_daemon().await;
    let mut ws = connected(daemon.addr()).await;
    let config = daemon.dir.path().join("data").join("config.toml");

    let id = add(
        &mut ws,
        &json!({ "cmd": "add_eq_preset", "request_id": "r1", "from": "rich", "name": "Vocal" }),
    )
    .await;
    assert_config_becomes(&config, &rich_clone_row(&id, "Vocal")).await;

    send_json(
        &mut ws,
        &json!({ "cmd": "rename_eq_preset", "request_id": "r2", "id": id, "name": "Vocal Forward" }),
    )
    .await;
    assert_eq!(recv_json(&mut ws).await["type"], "ack");
    assert_config_becomes(&config, &rich_clone_row(&id, "Vocal Forward")).await;

    send_json(&mut ws, &json!({ "cmd": "get_state", "request_id": "r3" })).await;
    let snapshot = recv_json(&mut ws).await["snapshot"].take();
    assert_eq!(snapshot["eq_presets"][3]["id"], id.as_str(), "id stable");
    assert_eq!(snapshot["eq_presets"][3]["name"], "Vocal Forward");
    assert!(
        daemon.stub.calls().is_empty(),
        "CRUD never touches the engine"
    );
}

/// Behaviors 4 + 7 (issue #26), the guard half: factory rename/remove,
/// custom reset, empty names, and unknown ids/sources are all
/// `INVALID_REQUEST` — engine untouched.
#[tokio::test]
async fn factory_and_custom_guards_are_invalid_request() {
    let daemon = start_daemon().await;
    let mut ws = connected(daemon.addr()).await;
    let custom = add(
        &mut ws,
        &json!({ "cmd": "add_profile", "request_id": "r0", "from": "music", "name": "Mine" }),
    )
    .await;
    let custom_preset = add(
        &mut ws,
        &json!({ "cmd": "add_eq_preset", "request_id": "r0b", "from": "rich", "name": "Vocal" }),
    )
    .await;

    for (request, needle) in [
        (
            json!({ "cmd": "rename_profile", "request_id": "r1", "id": "music", "name": "Loud" }),
            "factory profile `music` cannot be renamed or removed",
        ),
        (
            json!({ "cmd": "remove_profile", "request_id": "r2", "id": "music" }),
            "factory profile",
        ),
        (
            json!({ "cmd": "rename_eq_preset", "request_id": "r3", "id": "rich", "name": "Loud" }),
            "factory EQ preset `rich` cannot be renamed or removed",
        ),
        (
            json!({ "cmd": "remove_eq_preset", "request_id": "r4", "id": "rich" }),
            "factory EQ preset",
        ),
        (
            json!({ "cmd": "reset_profile", "request_id": "r5", "id": custom }),
            "cannot be reset — remove it instead",
        ),
        (
            json!({ "cmd": "reset_eq_preset", "request_id": "r6", "id": custom_preset }),
            "cannot be reset",
        ),
        (
            json!({ "cmd": "add_profile", "request_id": "r7", "from": "music", "name": "  " }),
            "name must not be empty",
        ),
        (
            json!({ "cmd": "rename_profile", "request_id": "r8", "id": "ghost", "name": "X" }),
            "unknown profile",
        ),
        (
            json!({ "cmd": "add_eq_preset", "request_id": "r9", "from": "ghost", "name": "X" }),
            "unknown EQ preset",
        ),
    ] {
        send_json(&mut ws, &request).await;
        let error = recv_json(&mut ws).await;
        assert_eq!(error["type"], "error", "wanted an error for {request}");
        assert_eq!(error["code"], "INVALID_REQUEST");
        assert!(
            error["message"].as_str().expect("message").contains(needle),
            "wanted {needle:?} in {error}"
        );
    }
    assert!(daemon.stub.calls().is_empty());
}

/// Behavior 5 (issue #26): removing a custom preset selected by two
/// profiles falls both back to `None`; flush-iff-live pushes the active
/// profile's own EQ params in one batch.
#[tokio::test]
async fn remove_eq_preset_falls_selectors_to_none_and_flushes_live() {
    let daemon = start_daemon().await;
    daemon
        .handle
        .supervisor()
        .create_session(48000)
        .expect("session");
    let mut originator = connected(daemon.addr()).await;
    let mut other = connected(daemon.addr()).await;

    let id = add(
        &mut originator,
        &json!({ "cmd": "add_eq_preset", "request_id": "r1", "from": "rich", "name": "Vocal" }),
    )
    .await;
    let _ = recv_state(&mut other).await;
    for (request_id, profile_id) in [("r2", "music"), ("r3", "movie")] {
        send_json(
            &mut originator,
            &json!({ "cmd": "set_eq_preset", "request_id": request_id, "profile_id": profile_id, "id": id }),
        )
        .await;
        assert_eq!(recv_json(&mut originator).await["type"], "ack");
        let _ = recv_state(&mut other).await;
    }
    let before = set_params_batches(&daemon.stub).len();

    send_json(
        &mut originator,
        &json!({ "cmd": "remove_eq_preset", "request_id": "r4", "id": id }),
    )
    .await;
    assert_eq!(recv_json(&mut originator).await["type"], "ack");

    let batches = set_params_batches(&daemon.stub);
    assert_eq!(batches.len(), before + 1, "one atomic fallback batch");
    let names: Vec<&str> = batches[before]
        .iter()
        .map(|(name, _)| name.as_str())
        .collect();
    assert_eq!(names, EQ_PARAMS, "the nine EQ params, in table order");
    let batch = by_name(&batches[before]);
    assert_eq!(batch["ieon"], [0], "music's own IEQ enable — no Off preset");
    assert_eq!(batch["iebt"], [0; 40], "music's own flat targets");

    // Both selectors fell back; the preset is gone globally.
    let snapshot = recv_state(&mut other).await["snapshot"].take();
    let presets = snapshot["eq_presets"].as_array().expect("array");
    assert_eq!(presets.len(), 3, "the removed preset is gone");
    for index in [0, 1] {
        assert_eq!(
            snapshot["profiles"][index]["selected_eq_preset"],
            serde_json::Value::Null,
            "selector {index} fell back to None"
        );
    }
}

/// Behavior 6 (issue #26): removing the selected custom profile falls
/// the selection back to `music` (`defaults.toml`'s
/// `selected_profile`), the engine getting Music's resolved set.
#[tokio::test]
async fn remove_selected_profile_falls_back_to_music() {
    let daemon = start_daemon().await;
    daemon
        .handle
        .supervisor()
        .create_session(48000)
        .expect("session");
    let mut ws = connected(daemon.addr()).await;

    let id = add(
        &mut ws,
        &json!({ "cmd": "add_profile", "request_id": "r1", "from": "music", "name": "Mine" }),
    )
    .await;
    send_json(
        &mut ws,
        &json!({ "cmd": "set_profile", "request_id": "r2", "id": id }),
    )
    .await;
    assert_eq!(recv_json(&mut ws).await["type"], "ack");
    // Diverge the clone so the fallback batch is observably Music's.
    send_json(
        &mut ws,
        &json!({ "cmd": "edit_profile", "request_id": "r3", "id": id, "params": { "dvla": [9] } }),
    )
    .await;
    assert_eq!(recv_json(&mut ws).await["type"], "ack");
    let before = set_params_batches(&daemon.stub).len();

    send_json(
        &mut ws,
        &json!({ "cmd": "remove_profile", "request_id": "r4", "id": id }),
    )
    .await;
    assert_eq!(recv_json(&mut ws).await["type"], "ack");

    let batches = set_params_batches(&daemon.stub);
    assert_eq!(batches.len(), before + 1, "one atomic fallback batch");
    let batch = by_name(&batches[before]);
    assert_eq!(batch["dvla"], [4], "Music's leveler, not the clone's [9]");

    send_json(&mut ws, &json!({ "cmd": "get_state", "request_id": "r5" })).await;
    let snapshot = recv_json(&mut ws).await["snapshot"].take();
    assert_eq!(snapshot["selected_profile"], "music");
    assert_eq!(
        snapshot["profiles"].as_array().expect("array").len(),
        4,
        "the clone is gone"
    );
}

/// Behavior 7 (issue #26): `reset_profile` clears a factory id's
/// `config.toml` overrides — the EQ preset selection included —
/// falling back to the shipped defaults (`defaults.toml` untouched by
/// construction: nothing ever writes it).
#[tokio::test]
async fn reset_profile_clears_config_overrides_for_factory_ids() {
    let daemon = start_daemon().await;
    let mut originator = connected(daemon.addr()).await;
    let mut other = connected(daemon.addr()).await;
    let config = daemon.dir.path().join("data").join("config.toml");

    send_json(
        &mut originator,
        &json!({ "cmd": "set_eq_preset", "request_id": "r1", "profile_id": "music", "id": "rich" }),
    )
    .await;
    assert_eq!(recv_json(&mut originator).await["type"], "ack");
    let _ = recv_state(&mut other).await;
    send_json(
        &mut originator,
        &json!({ "cmd": "edit_profile", "request_id": "r2", "id": "music", "params": { "dvla": [9] } }),
    )
    .await;
    assert_eq!(recv_json(&mut originator).await["type"], "ack");
    let _ = recv_state(&mut other).await;
    assert_config_becomes(
        &config,
        "[profile.music]\nselected_eq_preset = \"rich\"\ndvla = 9\n",
    )
    .await;

    send_json(
        &mut originator,
        &json!({ "cmd": "reset_profile", "request_id": "r3", "id": "music" }),
    )
    .await;
    assert_eq!(recv_json(&mut originator).await["type"], "ack");
    assert_config_becomes(&config, "").await;

    let snapshot = recv_state(&mut other).await["snapshot"].take();
    assert_eq!(
        snapshot["profiles"][1]["selected_eq_preset"],
        serde_json::Value::Null,
        "the selection was an override — reset clears it"
    );
    assert_eq!(snapshot["profiles"][1]["params"]["dvla"], json!([4]));
}

/// Behavior 8 (issue #26) / the tracer bullet's restart half: the whole
/// CRUD state — a renamed custom profile with its own edit and a custom
/// preset selection — survives a daemon restart.
#[tokio::test]
async fn custom_crud_survives_a_restart() {
    let daemon = start_daemon().await;
    let mut ws = connected(daemon.addr()).await;

    let profile_id = add(
        &mut ws,
        &json!({ "cmd": "add_profile", "request_id": "r1", "from": "music", "name": "Late Night" }),
    )
    .await;
    let preset_id = add(
        &mut ws,
        &json!({ "cmd": "add_eq_preset", "request_id": "r2", "from": "rich", "name": "Vocal" }),
    )
    .await;
    for request in [
        json!({ "cmd": "rename_profile", "request_id": "r3", "id": profile_id, "name": "Nocturne" }),
        json!({ "cmd": "set_eq_preset", "request_id": "r4", "profile_id": profile_id, "id": preset_id }),
        json!({ "cmd": "edit_profile", "request_id": "r5", "id": profile_id, "params": { "dvla": [9] } }),
    ] {
        send_json(&mut ws, &request).await;
        assert_eq!(recv_json(&mut ws).await["type"], "ack");
    }

    drop(ws);
    daemon.handle.shutdown().await;
    let (restarted, _stub) = start_over(&daemon.dir).await;
    let mut ws = ws_connect(restarted.addr()).await;
    let snapshot = recv_json(&mut ws).await["snapshot"].take();

    let profile = &snapshot["profiles"][4];
    assert_eq!(profile["id"], profile_id.as_str());
    assert_eq!(profile["name"], "Nocturne", "the rename survived");
    assert_eq!(profile["is_factory"], false);
    assert_eq!(profile["selected_eq_preset"], preset_id.as_str());
    assert_eq!(profile["params"]["dvla"], json!([9]), "the edit survived");
    assert_eq!(
        profile["params"]["dea"],
        json!([2]),
        "music's cloned override survived"
    );

    let preset = &snapshot["eq_presets"][3];
    assert_eq!(preset["id"], preset_id.as_str());
    assert_eq!(preset["name"], "Vocal");
    assert_eq!(preset["is_factory"], false);
    let iebt: Vec<i64> = preset["params"]["iebt"].as_array().expect("iebt")[..20]
        .iter()
        .map(|v| v.as_i64().expect("i64"))
        .collect();
    assert_eq!(iebt, RICH_IEBT.map(i64::from), "rich's cloned curve");
}
