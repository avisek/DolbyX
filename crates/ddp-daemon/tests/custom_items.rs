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

/// Behavior 3 (issue #26 A): a rename is an `edit_* { id, name }`
/// patch (ADR-0005 — no `rename_*` verb): customs rename with id
/// stable and no engine call; a factory `name` patch, an
/// empty-after-trim name, and the retired `rename_profile` cmd are
/// `INVALID_REQUEST`. Plain acks carry no `id` — that key is `add_*`'s.
#[tokio::test]
async fn edit_name_patches_rename_customs_and_reject_factory() {
    let daemon = start_daemon().await;
    let mut ws = connected(daemon.addr()).await;

    let profile_id = ack_of(
        &mut ws,
        &json!({ "cmd": "add_profile", "request_id": "r1", "name": "Music 2" }),
    )
    .await;
    let preset_id = ack_of(
        &mut ws,
        &json!({ "cmd": "add_eq_preset", "request_id": "r2", "name": "Preset 1" }),
    )
    .await;

    send_json(
        &mut ws,
        &json!({ "cmd": "edit_profile", "request_id": "r3", "id": profile_id, "name": "Late Night" }),
    )
    .await;
    let ack = recv_json(&mut ws).await;
    assert_eq!(ack["type"], "ack");
    assert!(
        !ack.as_object().expect("object").contains_key("id"),
        "the minted-id key is add_*'s alone: {ack}"
    );
    let _ = ack_of(
        &mut ws,
        &json!({ "cmd": "edit_eq_preset", "request_id": "r4", "id": preset_id, "name": "Warmth" }),
    )
    .await;

    send_json(&mut ws, &json!({ "cmd": "get_state", "request_id": "r5" })).await;
    let snapshot = recv_json(&mut ws).await["snapshot"].take();
    assert_eq!(snapshot["profiles"][4]["id"], profile_id, "id stable");
    assert_eq!(snapshot["profiles"][4]["name"], "Late Night");
    assert_eq!(snapshot["eq_presets"][3]["id"], preset_id, "id stable");
    assert_eq!(snapshot["eq_presets"][3]["name"], "Warmth");
    assert!(
        daemon.stub.calls().is_empty(),
        "a rename never touches the engine"
    );

    for (request, needle) in [
        (
            json!({ "cmd": "edit_profile", "request_id": "r6", "id": "music", "name": "Loud" }),
            "renamed",
        ),
        (
            json!({ "cmd": "edit_eq_preset", "request_id": "r7", "id": "rich", "name": "Loud" }),
            "renamed",
        ),
        (
            json!({ "cmd": "edit_profile", "request_id": "r8", "id": profile_id, "name": "   " }),
            "empty",
        ),
        (
            json!({ "cmd": "rename_profile", "request_id": "r9", "id": profile_id, "name": "X" }),
            "unknown variant `rename_profile`",
        ),
    ] {
        send_json(&mut ws, &request).await;
        let error = recv_json(&mut ws).await;
        assert_eq!(error["type"], "error", "{request}");
        assert_eq!(error["code"], "INVALID_REQUEST");
        assert!(
            error["message"].as_str().expect("message").contains(needle),
            "wanted {needle:?} in {error}"
        );
    }
}

/// Behavior 6 (issue #26 A): deleting the **selected** profile falls
/// the selection back to `defaults.toml`'s `selected_profile` and
/// hands the engine that profile's full resolved set; deleting a
/// non-selected custom never touches the engine.
#[tokio::test]
async fn removing_the_selected_profile_falls_back_to_defaults_selection() {
    let daemon = start_daemon().await;
    daemon
        .handle
        .supervisor()
        .create_session(48000)
        .expect("session");
    let mut originator = connected(daemon.addr()).await;
    let mut other = connected(daemon.addr()).await;

    let minted = ack_of(
        &mut originator,
        &json!({ "cmd": "add_profile", "request_id": "r1", "name": "Bass", "params": { "dvla": [9] } }),
    )
    .await;
    assert_eq!(recv_json(&mut other).await["type"], "state");
    let _ = ack_of(
        &mut originator,
        &json!({ "cmd": "set_profile", "request_id": "r2", "id": minted }),
    )
    .await;
    assert_eq!(recv_json(&mut other).await["type"], "state");

    let _ = ack_of(
        &mut originator,
        &json!({ "cmd": "remove_profile", "request_id": "r3", "id": minted }),
    )
    .await;
    let broadcast = recv_json(&mut other).await;
    assert_eq!(broadcast["type"], "state");
    assert_eq!(
        broadcast["snapshot"]["selected_profile"], "music",
        "defaults.toml's selected_profile"
    );
    assert_eq!(
        broadcast["snapshot"]["profiles"]
            .as_array()
            .expect("array")
            .len(),
        4,
        "the custom is gone"
    );
    let batches = set_params_batches(&daemon.stub);
    assert_eq!(batches.len(), 3, "init + switch + fallback");
    assert_eq!(
        batches[2], batches[0],
        "the engine gets Music's resolved set again"
    );

    // A non-selected custom delete: persists, engine silent.
    let minted = ack_of(
        &mut originator,
        &json!({ "cmd": "add_profile", "request_id": "r4", "name": "Idle" }),
    )
    .await;
    let _ = ack_of(
        &mut originator,
        &json!({ "cmd": "remove_profile", "request_id": "r5", "id": minted }),
    )
    .await;
    assert_eq!(
        set_params_batches(&daemon.stub).len(),
        3,
        "no engine call for a non-selected delete"
    );
}

/// Behavior 5 (issue #26 A): deleting a custom EQ preset selected by N
/// profiles falls **all N** to an explicit `None` — the reserved
/// `"none"` sentinel on disk, never the selection beneath — and, the
/// selected profile among them, flush-iff-live pushes its **own** EQ.
#[tokio::test]
async fn removing_a_selected_preset_pins_explicit_none_on_every_selector() {
    let daemon = start_daemon().await;
    daemon
        .handle
        .supervisor()
        .create_session(48000)
        .expect("session");
    let mut ws = connected(daemon.addr()).await;

    let minted = ack_of(
        &mut ws,
        &json!({ "cmd": "add_eq_preset", "request_id": "r1", "name": "Doomed", "params": { "iebt": [67, 95], "ieon": [1] } }),
    )
    .await;
    // N = 2 selectors: movie (offline) and music (the selected profile);
    // music's own GEQ diverges so the post-delete flush is observable.
    for (request_id, profile_id) in [("r2", "movie"), ("r3", "music")] {
        let _ = ack_of(
            &mut ws,
            &json!({ "cmd": "edit_profile", "request_id": request_id, "id": profile_id, "selected_eq_preset": minted }),
        )
        .await;
    }
    let _ = ack_of(
        &mut ws,
        &json!({ "cmd": "edit_profile", "request_id": "r4", "id": "music", "params": { "gebg": [16, -16] } }),
    )
    .await;

    let _ = ack_of(
        &mut ws,
        &json!({ "cmd": "remove_eq_preset", "request_id": "r5", "id": minted }),
    )
    .await;

    send_json(&mut ws, &json!({ "cmd": "get_state", "request_id": "r6" })).await;
    let snapshot = recv_json(&mut ws).await["snapshot"].take();
    assert_eq!(
        snapshot["eq_presets"].as_array().expect("array").len(),
        3,
        "the custom preset is gone"
    );
    for index in [0, 1] {
        assert_eq!(
            snapshot["profiles"][index]["selected_eq_preset"],
            serde_json::Value::Null,
            "every selector falls to None"
        );
    }

    // The live flush carries the selected profile's own EQ.
    let batches = set_params_batches(&daemon.stub);
    let batch: std::collections::HashMap<&str, &[i16]> = batches
        .last()
        .expect("the delete flushes")
        .iter()
        .map(|(name, values)| (name.as_str(), values.as_slice()))
        .collect();
    assert_eq!(batch.len(), 9, "the resolved EQ set");
    assert_eq!(batch["gebg"][..2], [16, -16], "music's own GEQ");
    assert_eq!(batch["ieon"], [0], "music's own IEQ enable — not the preset's");

    // Behavior 5's disk face: the explicit pin persists as the
    // reserved "none" sentinel on every selector's row.
    let mut gebg = vec![16_i16, -16];
    gebg.extend([0; 38]);
    let gebg = gebg
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    assert_config_becomes(
        &daemon.dir.path().join("data").join("config.toml"),
        &format!(
            "[profile.movie]\nselected_eq_preset = \"none\"\n\n[profile.music]\nselected_eq_preset = \"none\"\ngebg = [{gebg}]\n"
        ),
    )
    .await;
}

/// Behavior 4 (issue #26 A): factory items never delete — and unknown
/// ids reject — as `INVALID_REQUEST`, state untouched.
#[tokio::test]
async fn factory_and_unknown_deletes_are_invalid_request() {
    let daemon = start_daemon().await;
    let mut ws = connected(daemon.addr()).await;

    for (request, needle) in [
        (
            json!({ "cmd": "remove_profile", "request_id": "r1", "id": "music" }),
            "factory item `music` cannot be deleted",
        ),
        (
            json!({ "cmd": "remove_eq_preset", "request_id": "r2", "id": "rich" }),
            "factory item `rich` cannot be deleted",
        ),
        (
            json!({ "cmd": "remove_profile", "request_id": "r3", "id": "ghost" }),
            "unknown profile",
        ),
        (
            json!({ "cmd": "remove_eq_preset", "request_id": "r4", "id": "ghost" }),
            "unknown EQ preset",
        ),
    ] {
        send_json(&mut ws, &request).await;
        let error = recv_json(&mut ws).await;
        assert_eq!(error["type"], "error", "{request}");
        assert_eq!(error["code"], "INVALID_REQUEST");
        assert!(
            error["message"].as_str().expect("message").contains(needle),
            "wanted {needle:?} in {error}"
        );
    }
    assert!(daemon.stub.calls().is_empty());

    send_json(&mut ws, &json!({ "cmd": "get_state", "request_id": "r5" })).await;
    let snapshot = recv_json(&mut ws).await["snapshot"].take();
    assert_eq!(snapshot["profiles"].as_array().expect("array").len(), 4);
    assert_eq!(snapshot["eq_presets"].as_array().expect("array").len(), 3);
}

/// The slice's tracer bullet + behaviors 1 & 7 (issue #26 A): add a
/// custom profile with Music's content, rename it, add a custom preset
/// and select it, add-and-remove a second profile — restart — the
/// customs survive in `config.toml` rows (`[profile.user_<hash>]`, id
/// as the table key, `name` in the row), the removed one stays gone,
/// and `is_factory` is derived from `defaults.toml` presence — nothing
/// stored on disk.
#[tokio::test]
async fn tracer_bullet_add_rename_restart_survives() {
    let daemon = start_daemon().await;
    let mut ws = connected(daemon.addr()).await;

    send_json(&mut ws, &json!({ "cmd": "get_state", "request_id": "r1" })).await;
    let snapshot = recv_json(&mut ws).await["snapshot"].take();
    let music_params = snapshot["profiles"][1]["params"].clone();

    let profile_id = ack_of(
        &mut ws,
        &json!({ "cmd": "add_profile", "request_id": "r2", "name": "Music 2", "params": music_params }),
    )
    .await;
    let _ = ack_of(
        &mut ws,
        &json!({ "cmd": "edit_profile", "request_id": "r3", "id": profile_id, "name": "Late Night" }),
    )
    .await;
    let preset_id = ack_of(
        &mut ws,
        &json!({ "cmd": "add_eq_preset", "request_id": "r4", "name": "Warmth", "params": { "iebt": [67, 95], "ieon": [1] } }),
    )
    .await;
    let _ = ack_of(
        &mut ws,
        &json!({ "cmd": "edit_profile", "request_id": "r5", "id": profile_id, "selected_eq_preset": preset_id }),
    )
    .await;
    // Removed customs stay gone — the row is deleted, not blanked.
    let doomed = ack_of(
        &mut ws,
        &json!({ "cmd": "add_profile", "request_id": "r6", "name": "Temp" }),
    )
    .await;
    let _ = ack_of(
        &mut ws,
        &json!({ "cmd": "remove_profile", "request_id": "r7", "id": doomed }),
    )
    .await;

    drop(ws);
    daemon.handle.shutdown().await;

    // Behavior 1: the rows carry content only — factory-ness is derived
    // from defaults.toml presence at load, never stored.
    let config =
        std::fs::read_to_string(daemon.dir.path().join("data").join("config.toml")).unwrap();
    assert!(
        !config.contains("is_factory"),
        "factory-ness must not be stored: {config}"
    );
    let profile_key = format!("[profile.{}]", profile_id.as_str().unwrap());
    assert!(config.contains(&profile_key), "id is the table key: {config}");
    assert!(
        config.contains("name = \"Late Night\""),
        "the rename landed in the row: {config}"
    );

    let (restarted, _stub) = start_over(&daemon.dir).await;
    let mut ws = ws_connect(restarted.addr()).await;
    let snapshot = recv_json(&mut ws).await["snapshot"].take();

    let profiles = snapshot["profiles"].as_array().expect("array");
    assert_eq!(profiles.len(), 5, "four factory + the surviving custom");
    for (index, factory) in [true, true, true, true, false].into_iter().enumerate() {
        assert_eq!(profiles[index]["is_factory"], factory, "index {index}");
    }
    let custom = &profiles[4];
    assert_eq!(custom["id"], profile_id, "id stable across restart");
    assert_eq!(custom["name"], "Late Night", "the rename survived");
    assert_eq!(
        custom["params"], snapshot["profiles"][1]["params"],
        "Music's content survived, value for value"
    );
    assert_eq!(
        custom["selected_eq_preset"], preset_id,
        "the selection survived"
    );

    let presets = snapshot["eq_presets"].as_array().expect("array");
    assert_eq!(presets.len(), 4);
    assert_eq!(presets[3]["id"], preset_id);
    assert_eq!(presets[3]["name"], "Warmth");
    assert_eq!(presets[3]["is_factory"], false);
    assert_eq!(presets[3]["params"]["iebt"][0], 67);
    assert_eq!(presets[3]["params"]["ieon"], json!([1]));
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
