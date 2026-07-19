//! Slice 08 e2e suite (#16): the daemon against the **real** engine —
//! nothing mocked past the wire. Behavior 2 (Slice 04's power toggle
//! replayed over `QemuBackend`), behavior 4 (supervisor respawn), 5
//! (live readouts), 6 (power-off session init). Slice 10 (#18) adds
//! behavior 11: the resolved-profile init reshape, read back from the
//! live registry. Slice 11 (#19) adds its behavior 9: plugin behaviors
//! 2–5 replayed over the real platform socket. Slice 14 (#22) adds its
//! behavior 9: master-control edits read back from the registry.
//! Slice 15 (#23) adds its behavior 8: the EQ preset overlay lands
//! Rich's curve in the registry. Slice 16 (#24) adds its behavior 6:
//! `vis` events mirror the real reply tails, custom grid live.
//! Slice 18 (#26) adds its behavior 9: the CRUD tracer bullet — a
//! custom profile survives a restart, and removing it while selected
//! falls the registry back to Music.
//!
//! Feature-gated `qemu`; prerequisites as in
//! `ddp_engine::test_support`.
#![cfg(feature = "qemu")]

mod common;

use std::sync::Arc;

use common::plugin::SyntheticPlugin;
use common::{
    RICH_IEBT, assert_config_becomes, connected, recv_json, recv_state, send_json, set_power,
    socket_path_for, try_recv_json, vis_params_json, wait_until, ws_connect,
};
use ddp_daemon::Daemon;
use ddp_engine::test_support::staged_engine_dir;
use ddp_engine::{QemuBackend, SessionId};
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

    // And the WS connection keeps serving (the process block's `vis`
    // event may arrive first).
    send_json(&mut ws, &json!({ "cmd": "get_state", "request_id": "r9" })).await;
    let snapshot = recv_state(&mut ws).await;
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
    assert_eq!(
        by_name["endp"],
        [2],
        "pinned to the engine's HEADPHONES endpoint (AK encoding 2 — docs/ddp/02 `endp`)"
    );
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

/// Behavior 9 (issue #22): master-control edits — each half of the
/// three signature controls, written as the UI writes them (1-entry
/// `edit_profile` batches on Music, `vdhe` per `Tristate { on: 2 }`) —
/// land in the live clamped registry, confirmed by `get_params`, the
/// only true per-param getter.
#[tokio::test]
async fn master_control_edits_land_in_the_live_registry() {
    let daemon = start_qemu_daemon().await;
    let session = daemon
        .handle
        .supervisor()
        .create_session(48_000)
        .expect("session");

    let mut ws = connected(daemon.handle.addr()).await;
    // (4-CC, write) per widget half: SV off + full boost, DE off +
    // amount 8, VL on + amount 10 — every value diverges from Music's
    // boot state, so a stale registry can't pass.
    let edits = [
        ("vdhe", 0_i16),
        ("dhsb", 96),
        ("deon", 0),
        ("dea", 8),
        ("dvle", 1),
        ("dvla", 10),
    ];
    for (index, (name, value)) in edits.iter().enumerate() {
        send_json(
            &mut ws,
            &json!({
                "cmd": "edit_profile",
                "request_id": format!("rq-mc-{index}"),
                "id": "music",
                "params": { *name: [value] },
            }),
        )
        .await;
        assert_eq!(recv_json(&mut ws).await["type"], "ack");
    }

    let names: Vec<&str> = edits.iter().map(|(name, _)| *name).collect();
    let values = daemon
        .handle
        .supervisor()
        .get_params(session, &names)
        .expect("get_params");
    for ((name, written), read) in edits.iter().zip(&values) {
        assert_eq!(
            read.as_slice(),
            [*written],
            "`{name}` must read back from the clamped registry"
        );
    }
}

/// Behavior 8 (issue #23): the EQ preset overlay against the real
/// engine — after WS `set_eq_preset { music, rich }`, the live clamped
/// registry holds Rich's `iebt` curve with `ieon = 1`; a `null` detach
/// restores the profile's own (`ieon = 0`, flat targets).
#[tokio::test]
async fn set_eq_preset_lands_richs_curve_on_the_real_engine() {
    let daemon = start_qemu_daemon().await;
    let session = daemon
        .handle
        .supervisor()
        .create_session(48_000)
        .expect("session");

    let mut ws = connected(daemon.handle.addr()).await;
    send_json(
        &mut ws,
        &json!({ "cmd": "set_eq_preset", "request_id": "r1", "profile_id": "music", "id": "rich" }),
    )
    .await;
    assert_eq!(recv_json(&mut ws).await["type"], "ack");

    let values = daemon
        .handle
        .supervisor()
        .get_params(session, &["iebt", "ieon"])
        .expect("get_params");
    assert_eq!(
        values[0][..20],
        RICH_IEBT,
        "Rich's curve, read back from the live clamped registry"
    );
    assert_eq!(values[1], [1], "IEQ enabled by the overlay");

    // Detach: the profile's own EQ params land again.
    send_json(
        &mut ws,
        &json!({ "cmd": "set_eq_preset", "request_id": "r2", "profile_id": "music", "id": null }),
    )
    .await;
    assert_eq!(recv_json(&mut ws).await["type"], "ack");
    let values = daemon
        .handle
        .supervisor()
        .get_params(session, &["iebt", "ieon"])
        .expect("get_params");
    assert_eq!(values[0], vec![0; 40], "the profile's own flat targets");
    assert_eq!(values[1], [0], "the profile's own ieon = 0");
}

/// Behavior 9 (issue #26): the CRUD tracer bullet against the real
/// engine — add a custom profile from Music, rename it, restart the
/// daemon: it survives with the new name and Music's overrides. Then
/// select it, diverge it (registry-confirmed), and remove it — the
/// selection and the live registry fall back to Music.
#[tokio::test]
async fn custom_profile_crud_replays_on_the_real_engine() {
    let daemon = start_qemu_daemon().await;
    let mut ws = connected(daemon.handle.addr()).await;
    send_json(
        &mut ws,
        &json!({ "cmd": "add_profile", "request_id": "r1", "from": "music", "name": "Late Night" }),
    )
    .await;
    let ack = recv_json(&mut ws).await;
    assert_eq!(ack["type"], "ack");
    let id = ack["id"].as_str().expect("minted id").to_string();
    send_json(
        &mut ws,
        &json!({ "cmd": "rename_profile", "request_id": "r2", "id": id, "name": "Nocturne" }),
    )
    .await;
    assert_eq!(recv_json(&mut ws).await["type"], "ack");

    // Restart — fresh daemon, fresh engine process.
    drop(ws);
    let dir = daemon.dir;
    daemon.handle.shutdown().await;
    drop(daemon.backend);
    let restarted = start_qemu_daemon_over(dir).await;
    let mut ws = ws_connect(restarted.handle.addr()).await;
    let snapshot = recv_json(&mut ws).await["snapshot"].take();
    let profile = &snapshot["profiles"][4];
    assert_eq!(profile["id"], id.as_str(), "the clone survived the restart");
    assert_eq!(profile["name"], "Nocturne", "with its rename");
    assert_eq!(profile["is_factory"], false);
    assert_eq!(
        profile["params"]["dvla"],
        json!([4]),
        "and Music's cloned overrides"
    );

    // Select it and diverge it: the registry follows the clone…
    let session = restarted
        .handle
        .supervisor()
        .create_session(48_000)
        .expect("session");
    for request in [
        json!({ "cmd": "set_profile", "request_id": "r3", "id": id }),
        json!({ "cmd": "edit_profile", "request_id": "r4", "id": id, "params": { "dvla": [9] } }),
    ] {
        send_json(&mut ws, &request).await;
        assert_eq!(recv_json(&mut ws).await["type"], "ack");
    }
    let read_dvla = || {
        restarted
            .handle
            .supervisor()
            .get_params(session, &["dvla"])
            .expect("get_params")
    };
    assert_eq!(read_dvla()[0], [9], "the clone's divergence, live");

    // …and removing the selected clone falls back to Music.
    send_json(
        &mut ws,
        &json!({ "cmd": "remove_profile", "request_id": "r5", "id": id }),
    )
    .await;
    assert_eq!(recv_json(&mut ws).await["type"], "ack");
    assert_eq!(read_dvla()[0], [4], "Music's resolved set landed");
    send_json(&mut ws, &json!({ "cmd": "get_state", "request_id": "r6" })).await;
    let snapshot = recv_state(&mut ws).await["snapshot"].take();
    assert_eq!(snapshot["selected_profile"], "music");
    assert_eq!(snapshot["profiles"].as_array().expect("array").len(), 4);
}

/// Behavior 9 / tracer bullet (issue #19), plugin behaviors 2 + 3: a
/// synthetic plugin over the real platform socket — `Hello {48000}`
/// acked, silence round-trips within transient bounds, power on
/// transforms a tone, power off (bypass) echoes it exactly.
#[tokio::test]
async fn a_plugin_round_trips_audio_through_the_real_engine() {
    let daemon = start_qemu_daemon().await;
    let mut plugin = SyntheticPlugin::connect(&socket_path_for(&daemon.dir)).await;
    let session = plugin.hello(48_000, 256).await;
    assert_eq!(session, 0, "a fresh session id");

    // Silence in ⇒ silence out, once the enable crossfade's transient
    // has passed.
    let silence = vec![0_i16; 512];
    let mut output = Vec::new();
    for _ in 0..CROSSFADE_BLOCKS {
        output = plugin.process(&silence).await;
        assert_eq!(output.len(), silence.len(), "Processed mirrors Process");
    }
    let peak = output.iter().map(|sample| sample.unsigned_abs()).max();
    assert!(
        peak.expect("nonempty") <= 64,
        "silence stays within transient bounds, peak {peak:?}"
    );

    // Power on ⇒ the DSP audibly transforms a real tone…
    let tone = test_block();
    let mut processed = Vec::new();
    for _ in 0..CROSSFADE_BLOCKS {
        processed = plugin.process(&tone).await;
    }
    assert_ne!(processed, tone, "power on ⇒ processed PCM ≠ input");

    // …and power off bypasses it exactly (epic: `EFFECT_CMD_DISABLE`,
    // parameters survive), past the disable crossfade.
    let mut ws = connected(daemon.handle.addr()).await;
    set_power(&mut ws, false).await;
    let mut echoed = Vec::new();
    for _ in 0..CROSSFADE_BLOCKS {
        echoed = plugin.process(&tone).await;
    }
    assert_eq!(echoed, tone, "power off ⇒ OUT == IN");
    plugin.goodbye().await;
}

/// Behavior 9 (issue #19), plugin behavior 2's pitch-preservation
/// half: the engine session really runs at the plugin's `Hello` rate —
/// the rate-derived native grids of a 44.1 kHz and a 48 kHz session
/// differ once filled (a silent 44.1 fallback would make them equal).
#[tokio::test]
async fn the_engine_session_runs_at_the_plugins_hello_rate() {
    let daemon = start_qemu_daemon().await;
    let socket = socket_path_for(&daemon.dir);
    let mut at_44100 = SyntheticPlugin::connect(&socket).await;
    let mut at_48000 = SyntheticPlugin::connect(&socket).await;
    let a = SessionId(at_44100.hello(44_100, 256).await);
    let b = SessionId(at_48000.hello(48_000, 256).await);

    // The DSP-owned readout slots fill at the first process blocks.
    let block = test_block();
    for _ in 0..4 {
        at_44100.process(&block).await;
        at_48000.process(&block).await;
    }
    let grid = |session| {
        daemon
            .handle
            .supervisor()
            .get_params(session, &["vnbf"])
            .expect("read the native grid")
    };
    assert_ne!(
        grid(a),
        grid(b),
        "rate-derived native grids differ ⇒ SET_CONFIG ran at 48000, not a 44.1 fallback"
    );
}

/// Behavior 9 (issue #19), plugin behavior 4: two plugins multiplex
/// over the one shared engine subprocess with no crosstalk — in bypass
/// each hears exactly its own tone back; enabled, distinct tones stay
/// distinct.
#[tokio::test]
async fn two_plugins_multiplex_on_the_real_engine_without_crosstalk() {
    let daemon = start_qemu_daemon().await;
    // Power off first: both sessions are born disabled ⇒ dry from the
    // first block, so any cross-routing shows up as an exact mismatch.
    let mut ws = connected(daemon.handle.addr()).await;
    set_power(&mut ws, false).await;

    let socket = socket_path_for(&daemon.dir);
    let mut a = SyntheticPlugin::connect(&socket).await;
    let mut b = SyntheticPlugin::connect(&socket).await;
    a.hello(48_000, 256).await;
    b.hello(48_000, 256).await;

    let tone_a = test_block();
    let tone_b: Vec<i16> = test_block().iter().map(|sample| -sample).collect();
    for _ in 0..8 {
        assert_eq!(a.process(&tone_a).await, tone_a, "a hears exactly a");
        assert_eq!(b.process(&tone_b).await, tone_b, "b hears exactly b");
    }

    // Enabled, the sessions process independently: distinct tones stay
    // distinct.
    set_power(&mut ws, true).await;
    let (mut processed_a, mut processed_b) = (Vec::new(), Vec::new());
    for _ in 0..CROSSFADE_BLOCKS {
        processed_a = a.process(&tone_a).await;
        processed_b = b.process(&tone_b).await;
    }
    assert_ne!(processed_a, tone_a, "a is transformed");
    assert_ne!(processed_b, tone_b, "b is transformed");
    assert_ne!(processed_a, processed_b, "distinct tones stay distinct");
}

/// Behavior 9 (issue #19), plugin behavior 5 (+ the handover): a
/// `Goodbye` destroys the real session with the next-oldest taking
/// over as main; an abrupt disconnect destroys the last one.
#[tokio::test]
async fn goodbye_and_disconnect_destroy_real_sessions() {
    let daemon = start_qemu_daemon().await;
    let socket = socket_path_for(&daemon.dir);
    let mut a = SyntheticPlugin::connect(&socket).await;
    let mut b = SyntheticPlugin::connect(&socket).await;
    let session_a = SessionId(a.hello(44_100, 256).await);
    let session_b = SessionId(b.hello(48_000, 256).await);
    let supervisor = daemon.handle.supervisor();
    assert_eq!(supervisor.main_session(), Some(session_a));

    a.goodbye().await;
    wait_until(
        || supervisor.main_session() == Some(session_b),
        "Goodbye hands main over",
    )
    .await;

    drop(b); // no Goodbye — the host crashed / killed the plugin
    wait_until(
        || supervisor.main_session().is_none(),
        "abrupt disconnect destroys",
    )
    .await;
}

/// Behavior 8 (issue #19) against the real validation: a `Hello` rate
/// outside the engine's set trips Slice 08's host-side check — a
/// `Goodbye`, the connection closed, and the daemon healthy.
#[tokio::test]
async fn an_invalid_hello_rate_is_rejected_by_the_real_validation() {
    let daemon = start_qemu_daemon().await;
    let socket = socket_path_for(&daemon.dir);
    SyntheticPlugin::connect(&socket)
        .await
        .hello_rejected(96_000, 256)
        .await;
    assert_eq!(
        daemon.handle.supervisor().main_session(),
        None,
        "nothing was created"
    );

    // The daemon is healthy: the next plugin connects and processes.
    let mut ok = SyntheticPlugin::connect(&socket).await;
    ok.hello(48_000, 256).await;
    let block = test_block();
    assert_eq!(ok.process(&block).await.len(), block.len());
}

/// Behavior 6 (issue #24): the `vis` feed against the real engine —
/// every main-session block's event mirrors its reply tail verbatim; a
/// non-main block emits nothing; and the defaults-carried custom grid
/// is live: the DSP fills `vcbg`/`vcbe`, which at the power-on
/// `vcnb = 0` would read zero forever (probe `make vis` sec D).
#[tokio::test]
async fn vis_events_mirror_the_real_reply_tails() {
    let daemon = start_qemu_daemon().await;
    let supervisor = daemon.handle.supervisor();
    let main = supervisor.create_session(48_000).expect("main");
    let second = supervisor.create_session(48_000).expect("second");
    let mut ws = connected(daemon.handle.addr()).await;

    let block = test_block();
    let mut output = vec![0_i16; block.len()];
    let mut frames = Vec::new();
    for _ in 0..CROSSFADE_BLOCKS {
        frames.push(
            supervisor
                .process(main, &block, &mut output)
                .expect("process"),
        );
    }
    for (index, frame) in frames.iter().enumerate() {
        let event = recv_json(&mut ws).await;
        assert_eq!(event["type"], "vis", "block {index}");
        assert_eq!(
            event["params"],
            vis_params_json(frame),
            "block {index}: the reply tail, verbatim"
        );
    }

    let last = frames.last().expect("processed blocks");
    assert!(
        last.vcbe.iter().any(|&value| value != 0),
        "the custom grid is live: excitations filled, {:?}",
        last.vcbe
    );
    assert!(
        last.vcbg.iter().any(|&value| value != 0),
        "the custom grid is live: gains filled, {:?}",
        last.vcbg
    );

    supervisor
        .process(second, &block, &mut output)
        .expect("process");
    assert_eq!(
        try_recv_json(&mut ws, 300).await,
        None,
        "a non-main block emits nothing"
    );
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
