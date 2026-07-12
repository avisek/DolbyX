//! Behaviors 6–8 (issue #12): debounced overlay write-back, restart
//! reload, shutdown flush — against a real tempdir (mock policy).

mod common;

use common::{
    assert_config_becomes, connected, recv_json, set_power, start_daemon, start_over, ws_connect,
};

#[tokio::test]
async fn power_divergence_debounces_then_writes_only_the_overlay() {
    let daemon = start_daemon().await;
    let config = daemon.dir.path().join("data").join("config.toml");
    assert_eq!(
        std::fs::read(&config).expect("created on first run").len(),
        0,
        "fresh install: config.toml exists and is empty"
    );

    let mut ws = connected(daemon.addr()).await;
    set_power(&mut ws, false).await;

    // Inside the 500 ms debounce window nothing has hit the disk.
    assert_eq!(
        std::fs::read(&config).expect("config.toml readable").len(),
        0,
        "the write must debounce, not land immediately"
    );

    // Then exactly the divergence — factory `selected_profile` omitted.
    assert_config_becomes(&config, "power = false\n").await;

    // Back to factory: the divergence disappears again.
    set_power(&mut ws, true).await;
    assert_config_becomes(&config, "").await;
}

#[tokio::test]
async fn graceful_shutdown_flushes_a_pending_write() {
    let daemon = start_daemon().await;
    let config = daemon.dir.path().join("data").join("config.toml");

    let mut ws = connected(daemon.addr()).await;
    set_power(&mut ws, false).await;

    // Shut down inside the debounce window: the write is still pending.
    assert_eq!(std::fs::read(&config).expect("readable").len(), 0);
    drop(ws);
    daemon.handle.shutdown().await;

    assert_eq!(
        std::fs::read_to_string(&config).expect("readable"),
        "power = false\n",
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
    set_power(&mut ws, false).await;
    drop(ws);

    // Terminate inside the debounce window.
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
        "power = false\n",
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
