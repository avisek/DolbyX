//! Slice 15 behaviors (issue #23) on the Slice 18a content grammar
//! (issue #57): factory EQ presets apply as overlays — the EQ selection is an
//! `edit_profile` tri-state `selected_eq_preset` patch (ADR-0005) —
//! detach, global edits, reset, per-profile persistence, all over the
//! wire. Stub backend (mock policy) — `e2e_qemu.rs` replays the flow.

mod common;

use std::collections::HashMap;

use common::{
    RICH_IEBT, assert_config_becomes, connected, recv_json, send_json, set_params_batches,
    start_daemon, start_over, try_recv_json, ws_connect,
};
use serde_json::json;

/// The nine EQ params — the preset-carried set (`category ∈ {Ieq,
/// Geq}`), in the shipped table's order.
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

/// Behaviors 1 + 7 (issue #23): the snapshot carries the three factory
/// presets, each resolving standalone to the full nine EQ params via
/// the `[eq_preset]` shared band structure — and no factory profile
/// selects one (first-run parity: the original ships `ieon = 0`).
#[tokio::test]
async fn the_snapshot_carries_the_three_complete_factory_eq_presets() {
    let daemon = start_daemon().await;
    let mut ws = ws_connect(daemon.addr()).await;
    let snapshot = recv_json(&mut ws).await;

    let presets = snapshot["snapshot"]["eq_presets"]
        .as_array()
        .expect("eq_presets array");
    let names: Vec<(&str, &str)> = presets
        .iter()
        .map(|preset| {
            (
                preset["id"].as_str().expect("id"),
                preset["name"].as_str().expect("name"),
            )
        })
        .collect();
    assert_eq!(
        names,
        [("open", "Open"), ("rich", "Rich"), ("focused", "Focused")],
    );
    for preset in presets {
        assert_eq!(preset["is_factory"], true);
        let params = preset["params"].as_object().expect("params map");
        let mut keys: Vec<&str> = params.keys().map(String::as_str).collect();
        keys.sort_unstable();
        let mut expected = EQ_PARAMS;
        expected.sort_unstable();
        assert_eq!(keys, expected, "exactly the nine EQ params");
        assert_eq!(params["genb"], json!([20]), "standalone band structure");
        assert_eq!(params["ieon"], json!([1]), "factory presets stage IEQ on");
    }
    let rich_iebt = presets[1]["params"]["iebt"].as_array().expect("iebt");
    let head: Vec<i64> = rich_iebt[..20]
        .iter()
        .map(|v| v.as_i64().unwrap())
        .collect();
    assert_eq!(head, RICH_IEBT.map(i64::from));

    for profile in snapshot["snapshot"]["profiles"].as_array().expect("array") {
        assert_eq!(profile["selected_eq_preset"], serde_json::Value::Null);
    }
}

/// Behavior 1 (issue #57) / behavior 2 (issue #23): a WS
/// `edit_profile { id: "music", selected_eq_preset: "rich" }` patch →
/// the stub records **one** `set_params` carrying the resolved nine EQ
/// params — Rich's curve with `ieon = 1` among them; the EQ selection
/// lands on the profile and reaches the other client via broadcast.
#[tokio::test]
async fn tracer_bullet_an_eq_selection_patch_pushes_the_resolved_nine_in_one_batch() {
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
        &json!({ "cmd": "edit_profile", "request_id": "r1", "id": "music", "selected_eq_preset": "rich" }),
    )
    .await;
    let ack = recv_json(&mut originator).await;
    assert_eq!(ack["type"], "ack");
    assert_eq!(ack["request_id"], "r1");

    let batches = set_params_batches(&daemon.stub);
    assert_eq!(batches.len(), 2, "init + one atomic preset batch");
    let names: Vec<&str> = batches[1].iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(names, EQ_PARAMS, "all nine EQ params, in table order");
    let batch = by_name(&batches[1]);
    assert_eq!(batch["iebt"][..20], RICH_IEBT, "Rich's curve");
    assert_eq!(batch["ieon"], [1]);
    assert_eq!(batch["genb"], [20], "the preset resolves standalone");
    assert_eq!(
        batch["gebg"], [0; 40],
        "the preset's GEQ, not the profile's"
    );

    let broadcast = recv_json(&mut other).await;
    assert_eq!(broadcast["type"], "state");
    assert_eq!(
        broadcast["snapshot"]["profiles"][1]["selected_eq_preset"], "rich",
        "the EQ selection stored on the music profile"
    );
    assert_eq!(
        try_recv_json(&mut originator, 300).await,
        None,
        "no state event for the originator"
    );
}

/// Behavior 1 (issue #57) / behavior 3 (issue #23): a `null`
/// `selected_eq_preset` patch detaches — one `set_params` with the
/// profile's own EQ params again.
#[tokio::test]
async fn a_null_eq_selection_patch_detaches_to_the_profiles_own_eq() {
    let daemon = start_daemon().await;
    daemon
        .handle
        .supervisor()
        .create_session(48000)
        .expect("session");
    let mut ws = connected(daemon.addr()).await;

    // Give music's own EQ a divergence so the detach is observable.
    send_json(
        &mut ws,
        &json!({ "cmd": "edit_profile", "request_id": "r1", "id": "music", "params": { "gebg": [16, -16] } }),
    )
    .await;
    assert_eq!(recv_json(&mut ws).await["type"], "ack");
    send_json(
        &mut ws,
        &json!({ "cmd": "edit_profile", "request_id": "r2", "id": "music", "selected_eq_preset": "rich" }),
    )
    .await;
    assert_eq!(recv_json(&mut ws).await["type"], "ack");

    send_json(
        &mut ws,
        &json!({ "cmd": "edit_profile", "request_id": "r3", "id": "music", "selected_eq_preset": null }),
    )
    .await;
    assert_eq!(recv_json(&mut ws).await["type"], "ack");

    let batches = set_params_batches(&daemon.stub);
    assert_eq!(batches.len(), 4, "init + own edit + select + detach");
    let batch = by_name(&batches[3]);
    assert_eq!(batch.len(), 9);
    assert_eq!(batch["ieon"], [0], "the profile's own IEQ enable");
    assert_eq!(batch["iebt"], [0; 40], "the profile's own targets");
    assert_eq!(batch["gebg"][..2], [16, -16], "the profile's own GEQ kept");

    send_json(&mut ws, &json!({ "cmd": "get_state", "request_id": "r4" })).await;
    assert_eq!(
        recv_json(&mut ws).await["snapshot"]["profiles"][1]["selected_eq_preset"],
        serde_json::Value::Null,
    );
}

/// Behavior 4 (issue #23): `edit_eq_preset` on Rich's `iebt` flushes a
/// 1-entry batch while the active profile selects Rich, and — presets
/// being global — is visible to every selecting profile.
#[tokio::test]
async fn edit_eq_preset_flushes_for_the_active_profile_and_is_global() {
    let daemon = start_daemon().await;
    daemon
        .handle
        .supervisor()
        .create_session(48000)
        .expect("session");
    let mut ws = connected(daemon.addr()).await;

    // movie (non-selected) and music (selected) both select rich.
    for (request_id, profile_id) in [("r1", "movie"), ("r2", "music")] {
        send_json(
            &mut ws,
            &json!({ "cmd": "edit_profile", "request_id": request_id, "id": profile_id, "selected_eq_preset": "rich" }),
        )
        .await;
        assert_eq!(recv_json(&mut ws).await["type"], "ack");
    }
    let before = set_params_batches(&daemon.stub).len();

    let curve: Vec<i16> = RICH_IEBT.iter().map(|target| target + 16).collect();
    send_json(
        &mut ws,
        &json!({ "cmd": "edit_eq_preset", "request_id": "r3", "id": "rich", "params": { "iebt": curve } }),
    )
    .await;
    assert_eq!(recv_json(&mut ws).await["type"], "ack");

    let batches = set_params_batches(&daemon.stub);
    assert_eq!(batches.len(), before + 1, "the live edit flushes");
    let batch = by_name(&batches[before]);
    assert_eq!(batch.len(), 1, "exactly the edited entry");
    assert_eq!(batch["iebt"][..20], curve[..]);

    // One global preset: the snapshot's rich carries the edit, and both
    // selecting profiles see it through their EQ selection.
    send_json(&mut ws, &json!({ "cmd": "get_state", "request_id": "r4" })).await;
    let snapshot = recv_json(&mut ws).await["snapshot"].take();
    let rich_iebt = snapshot["eq_presets"][1]["params"]["iebt"]
        .as_array()
        .expect("iebt");
    let head: Vec<i64> = rich_iebt[..20]
        .iter()
        .map(|v| v.as_i64().unwrap())
        .collect();
    assert_eq!(
        head,
        curve.iter().map(|&v| i64::from(v)).collect::<Vec<_>>()
    );
    for index in [0, 1] {
        assert_eq!(snapshot["profiles"][index]["selected_eq_preset"], "rich");
    }
}

/// Behavior 5 (issue #23): an EQ selection patch targeting a non-selected
/// profile persists (flush + broadcast) without an engine call.
#[tokio::test]
async fn a_selection_patch_on_a_non_selected_profile_skips_the_engine() {
    let daemon = start_daemon().await;
    daemon
        .handle
        .supervisor()
        .create_session(48000)
        .expect("session");
    let mut ws = connected(daemon.addr()).await;

    send_json(
        &mut ws,
        &json!({ "cmd": "edit_profile", "request_id": "r1", "id": "game", "selected_eq_preset": "focused" }),
    )
    .await;
    assert_eq!(recv_json(&mut ws).await["type"], "ack");
    assert_eq!(
        set_params_batches(&daemon.stub).len(),
        1,
        "init only — no engine call for a non-selected profile"
    );

    let config = daemon.dir.path().join("data").join("config.toml");
    assert_config_becomes(
        &config,
        "[profile.game]\nselected_eq_preset = \"focused\"\n",
    )
    .await;
}

/// Behavior 6 (issue #23): `selected_eq_preset` persists per-profile
/// as an `Option`, and a preset edit persists globally — both survive
/// a restart.
#[tokio::test]
async fn eq_selection_and_preset_edits_survive_a_restart() {
    let daemon = start_daemon().await;
    let mut ws = connected(daemon.addr()).await;

    for (request_id, profile_id, id) in [
        ("r1", "music", json!("rich")),
        ("r2", "game", json!("open")),
    ] {
        send_json(
            &mut ws,
            &json!({ "cmd": "edit_profile", "request_id": request_id, "id": profile_id, "selected_eq_preset": id }),
        )
        .await;
        assert_eq!(recv_json(&mut ws).await["type"], "ack");
    }
    send_json(
        &mut ws,
        &json!({ "cmd": "edit_eq_preset", "request_id": "r3", "id": "rich", "params": { "iebt": [100] } }),
    )
    .await;
    assert_eq!(recv_json(&mut ws).await["type"], "ack");

    // Exactly the divergences, per item.
    let config = daemon.dir.path().join("data").join("config.toml");
    let mut expected_iebt = RICH_IEBT.map(i64::from).to_vec();
    expected_iebt[0] = 100;
    expected_iebt.extend([0_i64; 20]);
    let expected_iebt = expected_iebt
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    assert_config_becomes(
        &config,
        &format!(
            "[profile.music]\nselected_eq_preset = \"rich\"\n\n[profile.game]\nselected_eq_preset = \"open\"\n\n[eq_preset.rich]\niebt = [{expected_iebt}]\n"
        ),
    )
    .await;

    drop(ws);
    daemon.handle.shutdown().await;
    let (restarted, _stub) = start_over(&daemon.dir).await;
    let mut ws = ws_connect(restarted.addr()).await;
    let snapshot = recv_json(&mut ws).await["snapshot"].take();
    assert_eq!(snapshot["profiles"][1]["selected_eq_preset"], "rich");
    assert_eq!(snapshot["profiles"][2]["selected_eq_preset"], "open");
    assert_eq!(
        snapshot["profiles"][0]["selected_eq_preset"],
        serde_json::Value::Null,
        "movie never selected one"
    );
    assert_eq!(snapshot["eq_presets"][1]["params"]["iebt"][0], 100);
}

/// `reset_eq_preset` drops the preset's `config.toml` overrides and
/// broadcasts a fresh snapshot.
#[tokio::test]
async fn reset_eq_preset_clears_overrides_and_broadcasts() {
    let daemon = start_daemon().await;
    let mut originator = connected(daemon.addr()).await;
    let mut other = connected(daemon.addr()).await;
    let config = daemon.dir.path().join("data").join("config.toml");

    send_json(
        &mut originator,
        &json!({ "cmd": "edit_eq_preset", "request_id": "r1", "id": "focused", "params": { "iea": [16] } }),
    )
    .await;
    assert_eq!(recv_json(&mut originator).await["type"], "ack");
    assert_eq!(recv_json(&mut other).await["type"], "state");
    assert_config_becomes(&config, "[eq_preset.focused]\niea = 16\n").await;

    send_json(
        &mut originator,
        &json!({ "cmd": "reset_eq_preset", "request_id": "r2", "id": "focused" }),
    )
    .await;
    assert_eq!(recv_json(&mut originator).await["type"], "ack");

    let broadcast = recv_json(&mut other).await;
    assert_eq!(broadcast["type"], "state");
    assert_eq!(
        broadcast["snapshot"]["eq_presets"][2]["params"]["iea"],
        json!([10]),
        "the fresh snapshot carries the factory value"
    );
    assert_config_becomes(&config, "").await;
}

/// Validation on the wire (epic validation section): unknown ids and
/// non-preset-carried params are `INVALID_REQUEST`, engine untouched —
/// and the folded `set_eq_preset` cmd is gone from the wire (behavior
/// 1, issue #57): the old frame is an unknown cmd.
#[tokio::test]
async fn eq_preset_validation_failures_are_invalid_request() {
    let daemon = start_daemon().await;
    let mut ws = connected(daemon.addr()).await;

    for (request, needle) in [
        (
            json!({ "cmd": "edit_profile", "request_id": "r1", "id": "music", "selected_eq_preset": "ghost" }),
            "unknown EQ preset",
        ),
        (
            json!({ "cmd": "edit_profile", "request_id": "r2", "id": "ghost", "selected_eq_preset": "rich" }),
            "unknown profile",
        ),
        (
            json!({ "cmd": "edit_eq_preset", "request_id": "r3", "id": "rich", "params": { "dvla": [4] } }),
            "not preset-carried",
        ),
        (
            json!({ "cmd": "edit_eq_preset", "request_id": "r4", "id": "ghost", "params": { "iea": [4] } }),
            "unknown EQ preset",
        ),
        (
            json!({ "cmd": "reset_eq_preset", "request_id": "r5", "id": "ghost" }),
            "unknown EQ preset",
        ),
        (
            json!({ "cmd": "set_eq_preset", "request_id": "r6", "profile_id": "music", "id": "rich" }),
            "unknown variant `set_eq_preset`",
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

/// Behavior 2 (issue #57): a mixed `edit_profile` patch — params +
/// selection — applies atomically: one engine batch carries the new
/// effective EQ set alongside the non-EQ edit; an invalid part rejects
/// the whole command, nothing lands.
#[tokio::test]
async fn a_mixed_patch_applies_atomically_and_rejects_whole() {
    let daemon = start_daemon().await;
    daemon
        .handle
        .supervisor()
        .create_session(48000)
        .expect("session");
    let mut ws = connected(daemon.addr()).await;

    send_json(
        &mut ws,
        &json!({
            "cmd": "edit_profile",
            "request_id": "r1",
            "id": "music",
            "params": { "dvla": [9] },
            "selected_eq_preset": "rich",
        }),
    )
    .await;
    assert_eq!(recv_json(&mut ws).await["type"], "ack");

    let batches = set_params_batches(&daemon.stub);
    assert_eq!(batches.len(), 2, "init + one atomic mixed batch");
    let batch = by_name(&batches[1]);
    assert_eq!(batch.len(), 10, "the nine EQ params + the non-EQ edit");
    assert_eq!(batch["dvla"], [9], "the non-EQ edit rides along");
    assert_eq!(batch["iebt"][..20], RICH_IEBT, "Rich's curve");
    assert_eq!(batch["ieon"], [1]);

    // An invalid EQ selection rejects the valid param half too.
    let calls_before = daemon.stub.calls().len();
    send_json(
        &mut ws,
        &json!({
            "cmd": "edit_profile",
            "request_id": "r2",
            "id": "music",
            "params": { "dvla": [3] },
            "selected_eq_preset": "ghost",
        }),
    )
    .await;
    let error = recv_json(&mut ws).await;
    assert_eq!(error["type"], "error");
    assert_eq!(error["code"], "INVALID_REQUEST");
    assert_eq!(daemon.stub.calls().len(), calls_before, "engine untouched");

    send_json(&mut ws, &json!({ "cmd": "get_state", "request_id": "r3" })).await;
    let snapshot = recv_json(&mut ws).await["snapshot"].take();
    assert_eq!(
        snapshot["profiles"][1]["params"]["dvla"],
        json!([9]),
        "the rejected patch left the earlier value"
    );
    assert_eq!(snapshot["profiles"][1]["selected_eq_preset"], "rich");
}
