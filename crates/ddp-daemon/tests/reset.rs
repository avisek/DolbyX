//! Slice 18 part B behaviors (issue #26): reset & `overridden` over
//! the wire — `reset_* { id, only? }` universal on every item, dropping
//! `config.toml` divergences so the cascade beneath resolves
//! (ADR-0007); the snapshot's per-item `overridden` list (reset's
//! dual); `defaults.toml`-shipped factory selections. Stub backend
//! (mock policy) — behavior 5 replays the flow in `e2e_qemu.rs`.

mod common;

use std::sync::Arc;

use common::{
    assert_config_becomes, config_for, connected, fixture_dir, recv_json, send_json,
    set_params_batches, start_daemon, start_over, ws_connect,
};
use ddp_daemon::Daemon;
use ddp_engine::StubBackend;
use serde_json::json;

/// The nine preset-carried params (`category ∈ {Ieq, Geq}`, ADR-0003)
/// — part C's None-row Reset scope.
const THE_NINE: [&str; 9] = [
    "genb", "gebf", "geon", "gebg", "ienb", "iebf", "ieon", "iebt", "iea",
];

/// Sends `command` and awaits its `ack` (ADR-0005: replies settle
/// promise-style).
async fn ack_of(ws: &mut common::WsClient, command: &serde_json::Value) {
    send_json(ws, command).await;
    let reply = recv_json(ws).await;
    assert_eq!(reply["type"], "ack", "expected an ack, got {reply}");
    assert_eq!(reply["request_id"], command["request_id"]);
}

/// Issues `get_state` and returns the fresh snapshot.
async fn snapshot_of(ws: &mut common::WsClient, request_id: &str) -> serde_json::Value {
    send_json(ws, &json!({ "cmd": "get_state", "request_id": request_id })).await;
    recv_json(ws).await["snapshot"].take()
}

/// The slice's tracer bullet + behavior 3 (issue #26 B): edit Music's
/// `dvle` — the snapshot's `overridden` gains the key live — then
/// `reset_profile { id: "music" }` puts the snapshot back at baseline,
/// `overridden` empty, the config row gone, and the engine hears the
/// restored full resolved set.
#[tokio::test]
async fn tracer_bullet_edit_reset_returns_music_to_baseline() {
    let daemon = start_daemon().await;
    daemon
        .handle
        .supervisor()
        .create_session(48000)
        .expect("session");
    let mut ws = connected(daemon.addr()).await;
    let config = daemon.dir.path().join("data").join("config.toml");

    // Every item ships divergence-free.
    let snapshot = snapshot_of(&mut ws, "r1").await;
    assert_eq!(snapshot["profiles"][1]["id"], "music");
    assert_eq!(snapshot["profiles"][1]["overridden"], json!([]));
    assert_eq!(snapshot["eq_presets"][1]["overridden"], json!([]));

    ack_of(
        &mut ws,
        &json!({ "cmd": "edit_profile", "request_id": "r2", "id": "music", "params": { "dvle": [1] } }),
    )
    .await;
    let snapshot = snapshot_of(&mut ws, "r3").await;
    assert_eq!(snapshot["profiles"][1]["params"]["dvle"], json!([1]));
    assert_eq!(snapshot["profiles"][1]["overridden"], json!(["dvle"]));
    assert_config_becomes(&config, "[profile.music]\ndvle = 1\n").await;

    ack_of(
        &mut ws,
        &json!({ "cmd": "reset_profile", "request_id": "r4", "id": "music" }),
    )
    .await;
    let snapshot = snapshot_of(&mut ws, "r5").await;
    assert_eq!(
        snapshot["profiles"][1]["params"]["dvle"],
        json!([0]),
        "Music's shipped leveler-off again"
    );
    assert_eq!(snapshot["profiles"][1]["overridden"], json!([]));
    assert_config_becomes(&config, "").await;

    let batches = set_params_batches(&daemon.stub);
    assert_eq!(batches.len(), 3, "init + the edit + the reset");
    assert_eq!(
        batches[2], batches[0],
        "a live whole-item reset flushes the baseline full set"
    );
}

/// Behavior 1 (issue #26 B): whole-item reset on factory AND custom
/// ids — divergences cleared, the custom falls to the shared layers
/// (never its birth content), `name` survives, the selection override
/// drops, `defaults.toml` untouched.
#[tokio::test]
async fn whole_item_reset_works_on_factory_and_custom_ids() {
    let daemon = start_daemon().await;
    let mut ws = connected(daemon.addr()).await;
    let defaults_path = daemon.dir.path().join("defaults.toml");
    let defaults_before = std::fs::read_to_string(&defaults_path).unwrap();

    // Factory: a param and the selection diverge; reset clears both.
    ack_of(
        &mut ws,
        &json!({ "cmd": "edit_profile", "request_id": "r1", "id": "music", "params": { "dvla": [9] }, "selected_eq_preset": "rich" }),
    )
    .await;
    let snapshot = snapshot_of(&mut ws, "r2").await;
    assert_eq!(
        snapshot["profiles"][1]["overridden"],
        json!(["dvla", "selected_eq_preset"]),
        "params in table order, the selection key appended"
    );
    ack_of(
        &mut ws,
        &json!({ "cmd": "reset_profile", "request_id": "r3", "id": "music" }),
    )
    .await;
    let snapshot = snapshot_of(&mut ws, "r4").await;
    let music = &snapshot["profiles"][1];
    assert_eq!(music["params"]["dvla"], json!([4]), "the bundled default");
    assert_eq!(
        music["selected_eq_preset"],
        serde_json::Value::Null,
        "the selection override drops with the whole item"
    );
    assert_eq!(music["overridden"], json!([]));

    // Custom: born diverging with a selection, then renamed.
    send_json(
        &mut ws,
        &json!({ "cmd": "add_profile", "request_id": "r5", "name": "Music 2", "params": { "dvla": [2] }, "selected_eq_preset": "rich" }),
    )
    .await;
    let minted = recv_json(&mut ws).await["id"].take();
    ack_of(
        &mut ws,
        &json!({ "cmd": "edit_profile", "request_id": "r6", "id": minted, "name": "Late Night" }),
    )
    .await;
    ack_of(
        &mut ws,
        &json!({ "cmd": "reset_profile", "request_id": "r7", "id": minted }),
    )
    .await;
    let snapshot = snapshot_of(&mut ws, "r8").await;
    let custom = &snapshot["profiles"][4];
    assert_eq!(custom["id"], minted);
    assert_eq!(
        custom["params"]["dvla"],
        json!([7]),
        "the shared layers — never the birth clone's 2"
    );
    assert_eq!(custom["selected_eq_preset"], serde_json::Value::Null);
    assert_eq!(custom["name"], "Late Night", "`name` never resets");
    assert_eq!(custom["overridden"], json!([]));

    // The custom EQ preset counterpart.
    send_json(
        &mut ws,
        &json!({ "cmd": "add_eq_preset", "request_id": "r9", "name": "Warmth", "params": { "iebt": [67, 95], "ieon": [1] } }),
    )
    .await;
    let minted = recv_json(&mut ws).await["id"].take();
    ack_of(
        &mut ws,
        &json!({ "cmd": "reset_eq_preset", "request_id": "r10", "id": minted }),
    )
    .await;
    let snapshot = snapshot_of(&mut ws, "r11").await;
    let preset = &snapshot["eq_presets"][3];
    assert_eq!(preset["id"], minted);
    assert_eq!(preset["params"]["ieon"], json!([0]), "the custom baseline");
    assert_eq!(preset["params"]["iebt"][0], 0);
    assert_eq!(preset["name"], "Warmth", "`name` never resets");
    assert_eq!(preset["overridden"], json!([]));

    assert_eq!(
        std::fs::read_to_string(&defaults_path).unwrap(),
        defaults_before,
        "reset never touches defaults.toml"
    );
}

/// Behavior 2 (issue #26 B): `only: [the 9]` — part C's None-row
/// gesture — clears exactly the nine preset-carried params, leaving a
/// diverging non-EQ key; the live flush carries exactly the restored
/// entries. An `only` key the item doesn't carry is `INVALID_REQUEST`,
/// state untouched.
#[tokio::test]
async fn scoped_reset_clears_exactly_the_named_keys() {
    let daemon = start_daemon().await;
    daemon
        .handle
        .supervisor()
        .create_session(48000)
        .expect("session");
    let mut ws = connected(daemon.addr()).await;

    ack_of(
        &mut ws,
        &json!({ "cmd": "edit_profile", "request_id": "r1", "id": "music", "params": { "dvla": [9], "gebg": [16, -16], "ieon": [1] } }),
    )
    .await;
    ack_of(
        &mut ws,
        &json!({ "cmd": "reset_profile", "request_id": "r2", "id": "music", "only": THE_NINE }),
    )
    .await;
    let snapshot = snapshot_of(&mut ws, "r3").await;
    let music = &snapshot["profiles"][1];
    assert_eq!(music["params"]["gebg"][0], 0, "cleared");
    assert_eq!(music["params"]["ieon"], json!([0]), "cleared");
    assert_eq!(music["params"]["dvla"], json!([9]), "outside the scope");
    assert_eq!(music["overridden"], json!(["dvla"]));

    // The live flush is exactly the restored entries — the diverging
    // two of the nine, at their baseline values.
    let batches = set_params_batches(&daemon.stub);
    let batch: std::collections::HashMap<&str, &[i16]> = batches
        .last()
        .expect("the scoped reset flushes")
        .iter()
        .map(|(name, values)| (name.as_str(), values.as_slice()))
        .collect();
    assert_eq!(batch.len(), 2, "restored entries only, got {batch:?}");
    assert_eq!(batch["ieon"], [0]);
    assert!(batch["gebg"].iter().all(|&value| value == 0));

    for (request, needle) in [
        (
            json!({ "cmd": "reset_profile", "request_id": "r4", "id": "music", "only": ["vnnb"] }),
            "`vnnb` is not a content key of `music`",
        ),
        (
            json!({ "cmd": "reset_profile", "request_id": "r5", "id": "music", "only": ["name"] }),
            "not a content key",
        ),
        (
            json!({ "cmd": "reset_profile", "request_id": "r6", "id": "music", "only": ["dvla", "xxxx"] }),
            "not a content key",
        ),
        (
            json!({ "cmd": "reset_eq_preset", "request_id": "r7", "id": "rich", "only": ["dvla"] }),
            "`dvla` is not a content key of `rich`",
        ),
        (
            json!({ "cmd": "reset_eq_preset", "request_id": "r8", "id": "rich", "only": ["selected_eq_preset"] }),
            "not a content key",
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
    let snapshot = snapshot_of(&mut ws, "r9").await;
    assert_eq!(
        snapshot["profiles"][1]["params"]["dvla"],
        json!([9]),
        "a rejected scope — valid key beside a bad one — must not mutate"
    );
}

/// Behavior 3 (issue #26 B): `overridden` tracks divergences live on
/// the broadcast snapshots — an edit adds the key, an edit back to the
/// baseline value removes it, a selection patch adds
/// `"selected_eq_preset"`, a preset edit tracks on the preset.
#[tokio::test]
async fn overridden_tracks_edits_back_to_baseline_live() {
    let daemon = start_daemon().await;
    let mut originator = connected(daemon.addr()).await;
    let mut other = connected(daemon.addr()).await;

    ack_of(
        &mut originator,
        &json!({ "cmd": "edit_profile", "request_id": "r1", "id": "music", "params": { "dvla": [9] } }),
    )
    .await;
    let broadcast = recv_json(&mut other).await;
    assert_eq!(
        broadcast["snapshot"]["profiles"][1]["overridden"],
        json!(["dvla"])
    );

    // Back to Music's shipped value: the divergence disappears.
    ack_of(
        &mut originator,
        &json!({ "cmd": "edit_profile", "request_id": "r2", "id": "music", "params": { "dvla": [4] } }),
    )
    .await;
    let broadcast = recv_json(&mut other).await;
    assert_eq!(
        broadcast["snapshot"]["profiles"][1]["overridden"],
        json!([])
    );

    ack_of(
        &mut originator,
        &json!({ "cmd": "edit_profile", "request_id": "r3", "id": "music", "selected_eq_preset": "rich" }),
    )
    .await;
    let broadcast = recv_json(&mut other).await;
    assert_eq!(
        broadcast["snapshot"]["profiles"][1]["overridden"],
        json!(["selected_eq_preset"])
    );

    ack_of(
        &mut originator,
        &json!({ "cmd": "edit_eq_preset", "request_id": "r4", "id": "rich", "params": { "iea": [16] } }),
    )
    .await;
    let broadcast = recv_json(&mut other).await;
    assert_eq!(
        broadcast["snapshot"]["eq_presets"][1]["overridden"],
        json!(["iea"])
    );
    ack_of(
        &mut originator,
        &json!({ "cmd": "reset_eq_preset", "request_id": "r5", "id": "rich" }),
    )
    .await;
    let broadcast = recv_json(&mut other).await;
    assert_eq!(
        broadcast["snapshot"]["eq_presets"][1]["overridden"],
        json!([])
    );
}

/// Patches the fixture's `defaults.toml` so Music's row ships
/// `selected_eq_preset = "open"`.
fn ship_open_on_music(dir: &tempfile::TempDir) {
    let path = dir.path().join("defaults.toml");
    let document = std::fs::read_to_string(&path).expect("read defaults");
    std::fs::write(
        &path,
        document.replace(
            "name = \"Music\"",
            "name = \"Music\"\nselected_eq_preset = \"open\"",
        ),
    )
    .expect("write patched defaults");
}

/// Behavior 4 (issue #26 B): a `defaults.toml` row shipping
/// `selected_eq_preset = "open"` loads as selection + baseline
/// (`overridden` empty); a detach diverges — persisting as the
/// reserved `"none"` sentinel and surviving restart as an explicit
/// no-preset — and a whole-item reset falls the selection back to the
/// shipped preset.
#[tokio::test]
async fn a_defaults_shipped_selection_loads_and_reset_falls_back_to_it() {
    let dir = fixture_dir();
    ship_open_on_music(&dir);
    let (daemon, _stub) = start_over(&dir).await;
    let config = dir.path().join("data").join("config.toml");
    let mut ws = connected(daemon.addr()).await;

    let snapshot = snapshot_of(&mut ws, "r1").await;
    assert_eq!(snapshot["profiles"][1]["selected_eq_preset"], "open");
    assert_eq!(
        snapshot["profiles"][1]["overridden"],
        json!([]),
        "the shipped selection is the baseline — nothing diverges"
    );

    ack_of(
        &mut ws,
        &json!({ "cmd": "edit_profile", "request_id": "r2", "id": "music", "selected_eq_preset": null }),
    )
    .await;
    let snapshot = snapshot_of(&mut ws, "r3").await;
    assert_eq!(
        snapshot["profiles"][1]["selected_eq_preset"],
        serde_json::Value::Null
    );
    assert_eq!(
        snapshot["profiles"][1]["overridden"],
        json!(["selected_eq_preset"]),
        "None over a selection beneath diverges"
    );
    assert_config_becomes(&config, "[profile.music]\nselected_eq_preset = \"none\"\n").await;

    // Restart: the sentinel reloads as an explicit no-preset — never
    // re-inheriting open.
    drop(ws);
    daemon.shutdown().await;
    let (restarted, _stub) = start_over(&dir).await;
    let mut ws = ws_connect(restarted.addr()).await;
    let snapshot = recv_json(&mut ws).await["snapshot"].take();
    assert_eq!(
        snapshot["profiles"][1]["selected_eq_preset"],
        serde_json::Value::Null,
        "the explicit no-preset survived the restart"
    );

    ack_of(
        &mut ws,
        &json!({ "cmd": "reset_profile", "request_id": "r4", "id": "music" }),
    )
    .await;
    let snapshot = snapshot_of(&mut ws, "r5").await;
    assert_eq!(
        snapshot["profiles"][1]["selected_eq_preset"], "open",
        "reset falls the selection back to the shipped factory preset"
    );
    assert_eq!(snapshot["profiles"][1]["overridden"], json!([]));
    assert_config_becomes(&config, "").await;
}

/// Behavior 4 (issue #26 B), refusal half: a `defaults.toml` row
/// naming an unknown preset, stating the config-only `"none"`
/// sentinel, or an item claiming the reserved id `none` — the daemon
/// refuses to start.
#[tokio::test]
async fn bad_defaults_selections_or_reserved_ids_refuse_start() {
    let cases: [(&str, &str, &str); 4] = [
        (
            "name = \"Music\"",
            "name = \"Music\"\nselected_eq_preset = \"ghost\"",
            "names no EQ preset",
        ),
        (
            "name = \"Music\"",
            "name = \"Music\"\nselected_eq_preset = \"none\"",
            "must name a defaults.toml preset",
        ),
        ("", "\n[profile.none]\nname = \"X\"\n", "reserved"),
        ("", "\n[eq_preset.none]\nname = \"X\"\n", "reserved"),
    ];
    for (needle_from, replacement, needle) in cases {
        let dir = fixture_dir();
        let path = dir.path().join("defaults.toml");
        let document = std::fs::read_to_string(&path).expect("read defaults");
        let patched = if needle_from.is_empty() {
            document + replacement
        } else {
            document.replace(needle_from, replacement)
        };
        std::fs::write(&path, patched).expect("write patched defaults");

        let error = match Daemon::start(config_for(&dir), Arc::new(StubBackend::new())).await {
            Err(error) => error.to_string(),
            Ok(_) => panic!("must refuse to start"),
        };
        assert!(
            error.contains("defaults.toml") && error.contains(needle),
            "wanted {needle:?} in: {error}"
        );
    }
}
