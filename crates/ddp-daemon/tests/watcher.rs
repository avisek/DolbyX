//! Behaviors 1–7 (issue #27): `config.toml` live two-way sync — real
//! filesystem, real notify watcher against a tempdir; engine stubbed
//! (mock policy). No clock mock: 100 ms windows keep real-sleep tests
//! fast.

mod common;

use common::{
    assert_config_becomes, connected, edit_param, recv_state, set_params_batches,
    snapshot_profile as profile, start_daemon, try_recv_json, wait_until,
};
use ddp_persistence::WINDOW;

/// The stub's `set_params` batches contain `param = values`, in any
/// batch — the "engine heard it" assertion.
fn engine_heard(stub: &ddp_engine::StubBackend, param: &str, values: &[i16]) -> bool {
    set_params_batches(stub).iter().any(|batch| {
        batch
            .iter()
            .any(|(name, held)| name == param && held == values)
    })
}

/// The tracer bullet — behavior 1: an external `config.toml` edit
/// re-resolves state within ~150 ms, broadcasts a fresh snapshot to
/// every client, and the live engine session hears the new value.
#[tokio::test]
async fn an_external_edit_broadcasts_state_and_reaches_the_engine() {
    let daemon = start_daemon().await;
    daemon
        .handle
        .supervisor()
        .create_session(48000)
        .expect("session");
    let config = daemon.dir.path().join("data").join("config.toml");
    let mut ws = connected(daemon.addr()).await;

    std::fs::write(&config, "[profile.music]\ndvla = 7\n").expect("hand-edit lands");

    let snapshot = recv_state(&mut ws).await;
    assert_eq!(
        profile(&snapshot, "music")["params"]["dvla"],
        serde_json::json!([7]),
        "the broadcast snapshot resolves the hand-edit"
    );
    wait_until(
        || engine_heard(&daemon.stub, "dvla", &[7]),
        "the engine hears dvla = 7",
    )
    .await;
}

/// Behavior 2: editing a shared-layer key (`[profile]`) re-resolves
/// every profile — items' rows and baselines alike (config-shared sits
/// beneath the item layer, above the `defaults.toml` item rows).
#[tokio::test]
async fn a_shared_layer_edit_re_resolves_every_profile() {
    let daemon = start_daemon().await;
    let config = daemon.dir.path().join("data").join("config.toml");
    let mut ws = connected(daemon.addr()).await;

    std::fs::write(&config, "[profile]\ndvla = 9\n").expect("hand-edit lands");

    let snapshot = recv_state(&mut ws).await;
    for id in ["movie", "music", "game", "voice"] {
        assert_eq!(
            profile(&snapshot, id)["params"]["dvla"],
            serde_json::json!([9]),
            "`{id}` resolves the shared layer over its own defaults row"
        );
    }
    assert_eq!(
        profile(&snapshot, "music")["baseline"]["params"]["dvla"],
        serde_json::json!([9]),
        "the baseline carries config-shared"
    );
}

/// Behavior 3, self-write half: the daemon's own flushes never echo
/// back as reloads — a ~10 Hz mutation burst broadcasts nothing to the
/// mutating client (its acks confirm; an echoed reload would land a
/// fresh snapshot on it). The trailing write carries the final value
/// (behavior 5).
#[tokio::test]
async fn own_flushes_never_echo_back_as_reloads() {
    let daemon = start_daemon().await;
    let config = daemon.dir.path().join("data").join("config.toml");
    let mut ws = connected(daemon.addr()).await;

    for value in 0..10 {
        edit_param(&mut ws, "music", "dvla", &[value]).await;
        tokio::time::sleep(WINDOW / 4).await;
    }

    // The file settles at the final value…
    assert_config_becomes(&config, "[profile.music]\ndvla = 9\n").await;
    // …and well past the last window no echo has landed.
    assert_eq!(
        try_recv_json(&mut ws, 300).await,
        None,
        "own flushes must not reload-broadcast"
    );
}

/// Root keys (`power`, `selected_profile`) apply like any mutation:
/// one hand-edit flips power on the live session and lands the
/// switched profile's batch — engine first, broadcast after, so both
/// asserts run unpolled.
#[tokio::test]
async fn root_key_edits_apply_like_mutations() {
    let daemon = start_daemon().await;
    let session = daemon
        .handle
        .supervisor()
        .create_session(48_000)
        .expect("session");
    let config = daemon.dir.path().join("data").join("config.toml");
    let mut ws = connected(daemon.addr()).await;

    std::fs::write(&config, "power = false\nselected_profile = \"movie\"\n")
        .expect("hand-edit lands");

    let snapshot = recv_state(&mut ws).await;
    assert_eq!(snapshot["snapshot"]["power"], false);
    assert_eq!(snapshot["snapshot"]["selected_profile"], "movie");
    assert!(
        daemon
            .stub
            .calls()
            .contains(&ddp_engine::Call::SetEnabled(session, false)),
        "the power flip reached the session"
    );
    assert!(
        engine_heard(&daemon.stub, "dvla", &[7]),
        "the switch's batch landed Movie's leveler (7 over Music's 4)"
    );
}

/// Behavior 4: rapid successive external writes collapse to one
/// reload per window — and a sustained external writer tracks at
/// ~10 Hz: reloads land throughout the stream (never starved to a
/// single trailing one), and the final value wins.
#[tokio::test]
async fn a_sustained_external_writer_tracks_at_window_cadence() {
    let daemon = start_daemon().await;
    let config = daemon.dir.path().join("data").join("config.toml");
    let mut ws = connected(daemon.addr()).await;

    // 41 distinct documents, 20 ms apart (~800 ms) — every write a
    // fresh value, ending on a 9 sentinel.
    let path = config.clone();
    let writer = tokio::task::spawn_blocking(move || {
        for value in (0..40).map(|i| i % 10) {
            std::fs::write(&path, format!("[profile.music]\ndvla = {value}\n"))
                .expect("external write");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        std::fs::write(&path, "[profile.music]\ndvla = 9\n").expect("external write");
    });

    // Collect reloads until the sentinel lands, then drain the quiet
    // tail. Bounded by time, not by inter-frame gaps: a loaded runner
    // can stall the socket past any gap a "settled" heuristic picks.
    writer.await.expect("writer thread");
    let sentinel = |frame: &serde_json::Value| {
        profile(frame, "music")["params"]["dvla"] == serde_json::json!([9])
    };
    let mut reloads = Vec::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
    while !reloads.last().is_some_and(sentinel) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the final value lands (got {} reloads)",
            reloads.len()
        );
        let frame = recv_state(&mut ws).await;
        reloads.push(frame);
    }
    while let Some(frame) = try_recv_json(&mut ws, 400).await {
        assert_eq!(frame["type"], "state");
        reloads.push(frame);
    }

    let last = reloads.last().expect("at least one reload");
    assert_eq!(
        profile(last, "music")["params"]["dvla"],
        serde_json::json!([9]),
        "the final value wins"
    );
    // ~800 ms of writes through 100 ms windows: a handful of reloads —
    // strictly fewer than the 41 writes (collapse), several (tracking).
    assert!(
        (3..=14).contains(&reloads.len()),
        "one reload per window, got {}",
        reloads.len()
    );
}

/// Behavior 5, burst half (the leading edge is persistence.rs's
/// `an_idle_mutation_writes_only_the_overlay_immediately`): a mutation
/// burst rewrites the file at ~10 Hz — one atomic replace per window,
/// not one per mutation — and the trailing write carries the final
/// value. A test-side watcher counts the daemon's rename-replaces.
#[tokio::test]
async fn a_mutation_burst_rewrites_at_window_cadence() {
    use notify::Watcher as _;

    let daemon = start_daemon().await;
    let data_dir = daemon.dir.path().join("data");
    let config = data_dir.join("config.toml");

    // Every daemon write is a rename onto config.toml — count exactly
    // the `To` legs (inotify also emits `From` and a merged `Both` per
    // rename; counting one leg counts each replace once).
    let (tx, rx) = std::sync::mpsc::channel();
    let mut renames = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if let Ok(event) = event
            && matches!(
                event.kind,
                notify::EventKind::Modify(notify::event::ModifyKind::Name(
                    notify::event::RenameMode::To
                ))
            )
            && event
                .paths
                .iter()
                .any(|path| path.file_name().is_some_and(|name| name == "config.toml"))
        {
            let _ = tx.send(());
        }
    })
    .expect("test watcher");
    renames
        .watch(&data_dir, notify::RecursiveMode::NonRecursive)
        .expect("watch the data dir");

    let mut ws = connected(daemon.addr()).await;
    let started = tokio::time::Instant::now();
    for value in (0..20).map(|i| (i % 2) + 5) {
        edit_param(&mut ws, "music", "dvla", &[value]).await;
        tokio::time::sleep(WINDOW / 4).await;
    }
    let span = started.elapsed();
    assert_config_becomes(&config, "[profile.music]\ndvla = 6\n").await;
    tokio::time::sleep(std::time::Duration::from_millis(200)).await; // event drain

    let replaces = rx.try_iter().count();
    // One replace per elapsed window, plus the leading and trailing
    // edges — against 20 mutations.
    let ceiling = usize::try_from(span.as_millis() / WINDOW.as_millis()).expect("small") + 2;
    assert!(
        replaces >= 3,
        "mid-burst rewrites must land (leading edge + windows), got {replaces}"
    );
    assert!(
        replaces <= ceiling,
        "at most one replace per window, got {replaces} over {span:?}"
    );
}

/// Behavior 7, malformed: a mid-run edit that fails to parse — or to
/// validate — keeps last-good state (no broadcast, no crash); a UI
/// mutation overwrites the broken file (last-writer-wins) even when it
/// races the broken edit into the same window; and a later valid
/// external write reloads normally.
#[tokio::test]
async fn a_malformed_edit_keeps_last_good_state_until_recovery() {
    let daemon = start_daemon().await;
    let config = daemon.dir.path().join("data").join("config.toml");
    let mut ws = connected(daemon.addr()).await;

    edit_param(&mut ws, "music", "dvla", &[6]).await;
    assert_config_becomes(&config, "[profile.music]\ndvla = 6\n").await;

    // A UI mutation right behind the broken bytes — before the window
    // has even ingested them: the write-back defers one window, then
    // overwrites the broken file (a rejected edit is no cutover).
    std::fs::write(&config, "not toml [[[").expect("broken edit lands");
    edit_param(&mut ws, "music", "dvla", &[3]).await;
    assert_config_becomes(&config, "[profile.music]\ndvla = 3\n").await;

    // The invalid-under-validation flavor: same last-good bucket.
    std::fs::write(&config, "[profile.music]\ndvla = 99\n").expect("broken edit lands");
    assert_eq!(
        try_recv_json(&mut ws, 300).await,
        None,
        "malformed ⇒ keep last-good state, no broadcast"
    );

    // And the next valid external write recovers (refuse-to-start
    // applies only at startup).
    std::fs::write(&config, "[profile.music]\ndvla = 8\n").expect("valid edit lands");
    let snapshot = recv_state(&mut ws).await;
    assert_eq!(
        profile(&snapshot, "music")["params"]["dvla"],
        serde_json::json!([8]),
        "a valid write recovers the sync"
    );
}

/// Behavior 7, absent: deleting the file mid-run keeps last-good state
/// (vim's save dance has a transient no-file window); the next flush
/// recreates it.
#[tokio::test]
async fn an_absent_file_keeps_state_and_the_next_flush_recreates_it() {
    let daemon = start_daemon().await;
    let config = daemon.dir.path().join("data").join("config.toml");
    let mut ws = connected(daemon.addr()).await;

    edit_param(&mut ws, "music", "dvla", &[6]).await;
    assert_config_becomes(&config, "[profile.music]\ndvla = 6\n").await;

    std::fs::remove_file(&config).expect("file removed");
    assert_eq!(
        try_recv_json(&mut ws, 300).await,
        None,
        "absent ⇒ keep last-good state, no broadcast"
    );

    edit_param(&mut ws, "music", "dvla", &[2]).await;
    assert_config_becomes(&config, "[profile.music]\ndvla = 2\n").await;
}

/// Behavior 7, emptied: an empty file is *valid* — zero divergences ⇒
/// factory state, mid-run as at startup (deliberate wipe is emptying
/// the file, never deleting it). Reload never writes: the file stays
/// empty.
#[tokio::test]
async fn an_emptied_file_resolves_factory_state() {
    let daemon = start_daemon().await;
    let config = daemon.dir.path().join("data").join("config.toml");
    let mut ws = connected(daemon.addr()).await;

    edit_param(&mut ws, "music", "dvla", &[6]).await;
    assert_config_becomes(&config, "[profile.music]\ndvla = 6\n").await;

    std::fs::write(&config, "").expect("wipe lands");

    let snapshot = recv_state(&mut ws).await;
    assert_eq!(
        profile(&snapshot, "music")["params"]["dvla"],
        serde_json::json!([4]),
        "the divergence cleared — music falls to its factory dvla"
    );
    tokio::time::sleep(WINDOW * 3).await;
    assert_eq!(
        std::fs::read_to_string(&config).expect("readable"),
        "",
        "reload never writes the file"
    );
}

/// Behavior 3 (hand-edit between own flushes) + behavior 6 (an
/// accepted reload discards the pending write-back): a hand-edit
/// landing mid-burst — inside the throttle window, before the trailing
/// write fires — still reloads, and the file keeps the hand-edit once
/// the window passes: file wins, the discarded trailing write never
/// lands.
#[tokio::test]
async fn a_hand_edit_mid_burst_reloads_and_wins_the_file() {
    let daemon = start_daemon().await;
    let config = daemon.dir.path().join("data").join("config.toml");
    let mut ws = connected(daemon.addr()).await;

    // A burst: the leading write lands dvla = 2; the second mutation —
    // inside the same window — arms the pending trailing write.
    edit_param(&mut ws, "music", "dvla", &[2]).await;
    edit_param(&mut ws, "music", "dvla", &[3]).await;
    let hand_edit = "[profile.music]\ndvla = 7\n";
    std::fs::write(&config, hand_edit).expect("hand-edit lands mid-window");

    // It reloads — the broadcast reaches even the burst's originator…
    let snapshot = recv_state(&mut ws).await;
    assert_eq!(
        profile(&snapshot, "music")["params"]["dvla"],
        serde_json::json!([7]),
        "the hand-edit is the accepted truth"
    );

    // …and holds the file once the throttle window passes.
    tokio::time::sleep(WINDOW * 3).await;
    assert_eq!(
        std::fs::read_to_string(&config).expect("readable"),
        hand_edit,
        "file wins: the pending trailing write was discarded"
    );
}
