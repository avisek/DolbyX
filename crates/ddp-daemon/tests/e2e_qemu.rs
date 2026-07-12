//! Slice 08 e2e suite (#16): the daemon against the **real** engine —
//! nothing mocked past the wire. Behavior 2 (Slice 04's power toggle
//! replayed over `QemuBackend`), behavior 4 (supervisor respawn), 5
//! (live readouts), 6 (power-off session init). Slice 10 (#18) adds
//! behavior 11: the resolved-profile init reshape, read back from the
//! live registry.
//!
//! Feature-gated `qemu`; prerequisites as in
//! `ddp_engine::test_support`.
#![cfg(feature = "qemu")]

mod common;

use std::sync::Arc;

use common::{assert_config_becomes, connected, recv_json, send_json, set_power, ws_connect};
use ddp_daemon::Daemon;
use ddp_engine::QemuBackend;
use ddp_engine::test_support::staged_engine_dir;
use serde_json::json;
use tempfile::TempDir;

/// Blocks that comfortably outlast both engine crossfades (enable 7560
/// samples, disable 5512 — `tools/ddp_probe/README.md` #6) at 256
/// frames per block.
const CROSSFADE_BLOCKS: usize = 40;

/// One 256-frame interleaved-stereo block (deterministic ramp) — for
/// bypass-identity checks, any nonzero content works.
fn test_block() -> Vec<i16> {
    (0..512)
        .map(|i| i16::try_from((i % 64) * 500).expect("fits i16") - 16_000)
        .collect()
}

/// An in-process daemon over the real engine, plus its fixture dir.
struct QemuDaemon {
    handle: Daemon,
    backend: Arc<QemuBackend>,
    dir: TempDir,
}

/// Starts a real-engine daemon over an existing fixture dir — the
/// restart primitive.
async fn start_qemu_daemon_over(dir: TempDir) -> QemuDaemon {
    let backend = Arc::new(QemuBackend::start(staged_engine_dir()).expect("engine starts"));
    let handle = common::start_with(&dir, backend.clone()).await;
    QemuDaemon {
        handle,
        backend,
        dir,
    }
}

/// Starts a real-engine daemon over a fresh fixture dir.
async fn start_qemu_daemon() -> QemuDaemon {
    start_qemu_daemon_over(common::fixture_dir()).await
}

/// The tracer bullet (issue #16): Slice 04's power toggle, end to end
/// against the real engine — WS → state → `EFFECT_CMD_DISABLE`
/// (audible bypass past the crossfade) → `config.toml` overlay →
/// restart reload.
#[tokio::test]
async fn power_toggle_persists() {
    let daemon = start_qemu_daemon().await;
    let session = daemon
        .handle
        .supervisor()
        .create_session(44_100)
        .expect("session");

    let mut ws = connected(daemon.handle.addr()).await;
    set_power(&mut ws, false).await;

    // The disable reached the engine: past its wet→dry crossfade a
    // disabled session deposits the dry input (`setconfig_probe` Sc9).
    let block = test_block();
    let mut output = vec![0_i16; block.len()];
    for _ in 0..CROSSFADE_BLOCKS {
        daemon
            .handle
            .supervisor()
            .process(session, &block, &mut output)
            .expect("process");
    }
    assert_eq!(output, block, "disabled ⇒ the engine deposits dry input");

    // The divergence lands in config.toml (500 ms shared debounce)…
    let config = daemon.dir.path().join("data").join("config.toml");
    assert_config_becomes(&config, "power = false\n").await;

    // …and a restart — fresh daemon, fresh engine process — reloads it.
    drop(ws);
    let dir = daemon.dir;
    daemon.handle.shutdown().await;
    drop(daemon.backend);
    let restarted = start_qemu_daemon_over(dir).await;
    let mut ws = ws_connect(restarted.handle.addr()).await;
    let snapshot = recv_json(&mut ws).await;
    assert_eq!(
        snapshot["snapshot"]["power"], false,
        "power survives the restart"
    );
}

/// Behavior 4 (issue #16): kill the subprocess mid-run — the
/// supervisor respawns it, the session map is rebuilt (same external
/// id), a subsequent `set_power` reaches the new process, and WS
/// clients keep working.
#[tokio::test]
async fn a_killed_engine_respawns_with_sessions_rebuilt() {
    let daemon = start_qemu_daemon().await;
    let session = daemon
        .handle
        .supervisor()
        .create_session(48_000)
        .expect("session");
    let pid = daemon.backend.pid().expect("live engine");

    ddp_engine::test_support::kill_engine(pid);

    // The next command recovers transparently: an ack, not an error…
    let mut ws = connected(daemon.handle.addr()).await;
    set_power(&mut ws, false).await;
    let respawned = daemon.backend.pid();
    assert!(respawned.is_some(), "engine respawned");
    assert_ne!(respawned, Some(pid), "…on a fresh subprocess");

    // …the same external id routes to the rebuilt session, which holds
    // the replayed state (disabled, never enabled ⇒ dry from block 1).
    let block = test_block();
    let mut output = vec![0_i16; block.len()];
    daemon
        .handle
        .supervisor()
        .process(session, &block, &mut output)
        .expect("the session map was rebuilt");
    assert_eq!(output, block, "the rebuilt session carries power off");

    // And the WS connection keeps serving.
    send_json(&mut ws, &json!({ "cmd": "get_state", "request_id": "r9" })).await;
    let snapshot = recv_json(&mut ws).await;
    assert_eq!(snapshot["snapshot"]["power"], false);
}

/// Behavior 5 (issue #16): with a main session live the snapshot
/// `readouts` carry the engine's values — `ver` is the engine version
/// `2.0.4.0`, and `vnnb` reads the engine's power-on `0` where the
/// curated table default is `20`: the values come from the registry,
/// not from `ParameterDef.default`.
#[tokio::test]
async fn snapshot_readouts_carry_live_engine_values() {
    let daemon = start_qemu_daemon().await;

    // Zero sessions: the table defaults.
    let mut ws = ws_connect(daemon.handle.addr()).await;
    let readouts = recv_json(&mut ws).await["snapshot"]["readouts"].take();
    assert_eq!(readouts["vnnb"], json!([20]), "defaults while no session");

    daemon
        .handle
        .supervisor()
        .create_session(44_100)
        .expect("session");
    send_json(&mut ws, &json!({ "cmd": "get_state", "request_id": "r1" })).await;
    let readouts = recv_json(&mut ws).await["snapshot"]["readouts"].take();
    assert_eq!(
        readouts["ver"],
        json!([2, 0, 4, 0]),
        "the engine version — formats as 2.0.4.0"
    );
    assert_eq!(
        readouts["vnnb"],
        json!([0]),
        "the engine's power-on value, live — not the table's [20]"
    );
}

/// Behavior 11 (issue #18): after session init the engine really is
/// 20-band with Music's character applied — the shim's commit-leaf
/// touch reshaped the 10-band power-on state in the same write. Read
/// back from the live clamped registry (`get_params` — the only true
/// per-param getter).
#[tokio::test]
async fn session_init_reshapes_the_engine_to_the_music_profile() {
    let daemon = start_qemu_daemon().await;
    let session = daemon
        .handle
        .supervisor()
        .create_session(44_100)
        .expect("session");

    let names = [
        "genb", "ienb", "gebf", "dvla", "dvle", "dea", "deon", "dhsb", "vdhe", "endp", "ven",
    ];
    let values = daemon
        .handle
        .supervisor()
        .get_params(session, &names)
        .expect("get_params");
    let by_name: std::collections::HashMap<&str, &[i16]> = names
        .iter()
        .zip(&values)
        .map(|(name, values)| (*name, values.as_slice()))
        .collect();

    assert_eq!(by_name["genb"], [20], "20-band — not the 10-band power-on");
    assert_eq!(by_name["ienb"], [20]);
    assert_eq!(
        by_name["gebf"][..20],
        [
            43, 129, 215, 301, 431, 603, 775, 947, 1206, 1550, 2067, 2756, 3618, 4651, 5685, 7063,
            8958, 11025, 13781, 18777
        ],
        "the original DDP band grid"
    );
    assert_eq!(by_name["dvla"], [4], "Music's leveler amount");
    assert_eq!(by_name["dvle"], [0], "Music ships the leveler off");
    assert_eq!(by_name["dea"], [2], "Music's dialog enhancer amount");
    assert_eq!(by_name["deon"], [1]);
    assert_eq!(by_name["dhsb"], [48], "Music's surround boost");
    assert_eq!(by_name["vdhe"], [2], "headphone virtualizer on auto");
    assert_eq!(by_name["endp"], [1], "pinned to the headphone endpoint");
    assert_eq!(by_name["ven"], [1], "visualizer feed on");
}

/// Behavior 11 (issue #18), switch half: the tracer bullet against the
/// real engine — WS `set_profile` lands Movie's values in the registry.
#[tokio::test]
async fn set_profile_lands_movies_values_on_the_real_engine() {
    let daemon = start_qemu_daemon().await;
    let session = daemon
        .handle
        .supervisor()
        .create_session(48_000)
        .expect("session");

    let mut ws = connected(daemon.handle.addr()).await;
    send_json(
        &mut ws,
        &json!({ "cmd": "set_profile", "request_id": "r1", "id": "movie" }),
    )
    .await;
    assert_eq!(recv_json(&mut ws).await["type"], "ack");

    let values = daemon
        .handle
        .supervisor()
        .get_params(session, &["dvla", "dea", "dhsb", "genb"])
        .expect("get_params");
    assert_eq!(values[0], [7], "Movie's leveler amount");
    assert_eq!(values[1], [3], "Movie's dialog enhancer amount");
    assert_eq!(values[2], [96], "Movie's surround boost");
    assert_eq!(values[3], [20], "still 20-band after the switch");
}

/// Behavior 6 (issue #16): a session created while power is off starts
/// disabled on the engine — never enabled, it bypasses from the first
/// block (an enabled session would be audibly transformed well past
/// the enable crossfade).
#[tokio::test]
async fn a_session_created_while_power_off_starts_disabled() {
    let dir = common::fixture_dir();
    std::fs::create_dir_all(dir.path().join("data")).expect("config dir");
    std::fs::write(
        dir.path().join("data").join("config.toml"),
        "power = false\n",
    )
    .expect("preset overlay");
    let daemon = start_qemu_daemon_over(dir).await;

    let session = daemon
        .handle
        .supervisor()
        .create_session(44_100)
        .expect("session");
    let block = test_block();
    let mut output = vec![0_i16; block.len()];
    for _ in 0..CROSSFADE_BLOCKS {
        daemon
            .handle
            .supervisor()
            .process(session, &block, &mut output)
            .expect("process");
        assert_eq!(output, block, "disabled from the first block onward");
    }
}
