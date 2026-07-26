//! Behaviors 6–8 (issue #12) under the revised write law (issue #27):
//! leading-edge throttled overlay write-back, restart reload, shutdown
//! flush — against a real tempdir (mock policy).

mod common;

use common::{
    assert_config_becomes, connected, edit_param, recv_json, set_power, start_daemon, start_over,
    ws_connect,
};

/// Behavior 5 (issue #27), leading edge: an idle mutation is on disk
/// immediately — well inside the 100 ms window a trailing writer would
/// still be sitting on — and it lands exactly the divergence.
#[tokio::test]
async fn an_idle_mutation_writes_only_the_overlay_immediately() {
    let daemon = start_daemon().await;
    let config = daemon.dir.path().join("data").join("config.toml");
    assert_eq!(
        std::fs::read(&config).expect("created on first run").len(),
        0,
        "fresh install: config.toml exists and is empty"
    );

    let mut ws = connected(daemon.addr()).await;
    set_power(&mut ws, false).await;

    // Exactly the divergence — factory `selected_profile` omitted —
    // inside the window (the leading edge, not a trailing debounce).
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(80);
    loop {
        let content = std::fs::read_to_string(&config).expect("config.toml readable");
        if content == "power = false\n" {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "an idle mutation must land immediately, file still holds {content:?}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }

    // Back to factory: the divergence disappears again (this write
    // rides the throttle's trailing edge — the toggle was a burst).
    set_power(&mut ws, true).await;
    assert_config_becomes(&config, "").await;
}

#[tokio::test]
async fn graceful_shutdown_flushes_a_pending_write() {
    let daemon = start_daemon().await;
    let config = daemon.dir.path().join("data").join("config.toml");

    let mut ws = connected(daemon.addr()).await;
    // A burst: the first mutation writes on the leading edge, the
    // second — inside the same window — arms the pending trailing
    // write shutdown must carry out.
    set_power(&mut ws, false).await;
    edit_param(&mut ws, "music", "dvla", &[5]).await;

    drop(ws);
    daemon.handle.shutdown().await;

    assert_eq!(
        std::fs::read_to_string(&config).expect("readable"),
        "power = false\n\n[profile.music]\ndvla = 5\n",
        "shutdown must flush the pending write"
    );
}

/// SIGTERM is the service-manager path of behavior 8: the real binary
/// must flush the pending write and exit cleanly.
#[cfg(unix)]
#[tokio::test]
async fn sigterm_flushes_the_pending_write_and_exits_zero() {
    use std::io::BufRead;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    let dir = common::fixture_dir();
    // `--backend stub`: this test exercises signal handling, not the
    // engine, and no staged engine sits beside the test binary.
    let mut child = Command::new(env!("CARGO_BIN_EXE_ddp-daemon"))
        .args(["--backend", "stub", "--port", "0", "--ui"])
        .arg(dir.path().join("index.html"))
        .arg("--config-dir")
        .arg(dir.path().join("data"))
        .arg("--socket-path")
        .arg(common::socket_path_for(&dir))
        .current_dir(dir.path())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("daemon binary spawns");

    // The daemon logs its bound address on stdout; --port 0 makes it
    // ephemeral.
    let stdout = child.stdout.take().expect("stdout piped");
    let reader = tokio::task::spawn_blocking(move || {
        for line in std::io::BufReader::new(stdout).lines() {
            let line = line.expect("stdout line");
            if let Some(addr) = line.split("addr=").nth(1) {
                return addr.trim().to_string();
            }
        }
        panic!("daemon never logged its address");
    });
    let Ok(addr) = tokio::time::timeout(Duration::from_secs(10), reader).await else {
        let _ = child.kill();
        panic!("daemon never logged its address within 10s");
    };
    let addr: std::net::SocketAddr = addr.expect("reader task").parse().expect("valid addr");

    let mut ws = connected(addr).await;
    // The burst that arms a pending trailing write (leading edge lands
    // the first mutation on its own).
    set_power(&mut ws, false).await;
    edit_param(&mut ws, "music", "dvla", &[5]).await;
    drop(ws);

    // Terminate while the trailing write is (typically) still pending.
    assert!(
        Command::new("kill")
            .args(["-TERM", &child.id().to_string()])
            .status()
            .expect("kill runs")
            .success()
    );
    let status = tokio::task::spawn_blocking(move || child.wait().expect("child waits"))
        .await
        .expect("wait task");
    assert!(status.success(), "graceful exit, got {status}");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("data").join("config.toml")).expect("readable"),
        "power = false\n\n[profile.music]\ndvla = 5\n",
        "SIGTERM must flush the pending write"
    );
}

#[tokio::test]
async fn a_restart_reloads_power_from_the_config_overlay() {
    let daemon = start_daemon().await;
    let config = daemon.dir.path().join("data").join("config.toml");

    let mut ws = connected(daemon.addr()).await;
    set_power(&mut ws, false).await;
    assert_config_becomes(&config, "power = false\n").await;

    drop(ws);
    daemon.handle.shutdown().await;

    let (restarted, _stub) = start_over(&daemon.dir).await;
    let mut ws = ws_connect(restarted.addr()).await;
    let snapshot = recv_json(&mut ws).await;
    assert_eq!(
        snapshot["snapshot"]["power"], false,
        "power must survive a restart"
    );
    assert_eq!(snapshot["snapshot"]["selected_profile"], "music");
}
