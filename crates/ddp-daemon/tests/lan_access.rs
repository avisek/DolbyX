//! Behaviors (issue #70): the LAN access toggle end to end (ADR-0012)
//! — the `lan_access` root scalar through listener, wire, persistence,
//! and watcher. The LAN door is the harness seam [`common::TEST_LAN_IP`]
//! (a second loopback address standing in for production's `0.0.0.0`),
//! so the suite binds loopback only and `cargo test` never raises a
//! firewall prompt. Engine stubbed (mock policy); HTTP, WS, and
//! persistence run real.

mod common;

use std::net::SocketAddr;

use common::{
    TEST_LAN_IP, TestDaemon, assert_config_becomes, assert_severed, bootstrap_json, config_for,
    connected, fixture_dir, http_get, recv_json, recv_state, send_json, set_lan_access, set_power,
    start_daemon, start_over, wait_connectable, wait_refused, ws_connect,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// The daemon's LAN door: [`TEST_LAN_IP`] on the effective port.
fn lan_addr(daemon: &TestDaemon) -> SocketAddr {
    (TEST_LAN_IP, daemon.addr().port()).into()
}

/// The loopback door on the daemon's effective port — [`Daemon::addr`]
/// itself names the boot-time door, which is the LAN one when
/// `lan_access` resolved on at startup.
fn loopback_addr(daemon: &TestDaemon) -> SocketAddr {
    (std::net::Ipv4Addr::LOCALHOST, daemon.addr().port()).into()
}

/// Behavior 1: a fresh install stays this-PC-only — the snapshot and
/// bootstrap carry `lan_access: false`, and the LAN door is not even
/// bound.
#[tokio::test]
async fn a_fresh_install_stays_this_pc_only() {
    let daemon = start_daemon().await;

    let mut ws = ws_connect(daemon.addr()).await;
    let snapshot = recv_state(&mut ws).await;
    assert_eq!(snapshot["snapshot"]["lan_access"], false);

    let (status, body) = http_get(daemon.addr(), "/").await;
    assert_eq!(status, 200);
    assert_eq!(bootstrap_json(&body)["state"]["lan_access"], false);

    wait_refused(lan_addr(&daemon)).await;
}

/// The tracer bullet — behaviors 2 + 3: toggling on rebinds live (no
/// daemon restart): the LAN door serves the UI and a remote client
/// drives it — commands ack and fan out to the loopback client.
#[tokio::test]
async fn toggling_on_opens_the_lan_door_live() {
    let daemon = start_daemon().await;
    let mut local = connected(daemon.addr()).await;

    set_lan_access(&mut local, true).await;
    wait_connectable(lan_addr(&daemon)).await;

    // The LAN door serves the bootstrap-injected UI…
    let (status, body) = http_get(lan_addr(&daemon), "/").await;
    assert_eq!(status, 200);
    assert_eq!(bootstrap_json(&body)["state"]["lan_access"], true);

    // …and the full WS: snapshot on connect, then a remote mutation
    // acks and reaches the loopback client's snapshot feed.
    let mut remote = ws_connect(lan_addr(&daemon)).await;
    let snapshot = recv_json(&mut remote).await;
    assert_eq!(snapshot["type"], "state");
    assert_eq!(snapshot["snapshot"]["lan_access"], true);
    set_power(&mut remote, false).await;
    let broadcast = recv_state(&mut local).await;
    assert_eq!(broadcast["snapshot"]["power"], false);

    // The loopback client that flipped the toggle was never touched.
    set_power(&mut local, true).await;
}

/// Behavior 4: toggling off severs established LAN-door connections —
/// the loopback client stays, the LAN door refuses fresh connections,
/// and the loopback door serves again.
#[tokio::test]
async fn toggling_off_severs_remote_connections() {
    let daemon = start_daemon().await;
    let mut local = connected(daemon.addr()).await;
    set_lan_access(&mut local, true).await;
    wait_connectable(lan_addr(&daemon)).await;
    let mut remote = connected(lan_addr(&daemon)).await;

    set_lan_access(&mut local, false).await;

    assert_severed(&mut remote).await;
    wait_refused(lan_addr(&daemon)).await;
    wait_connectable(daemon.addr()).await;
    let _ = connected(daemon.addr()).await;
    // The loopback client rides on, untouched.
    set_power(&mut local, false).await;
}

/// Behavior 5: a remote device toggling off severs itself — the
/// originator gets its ack, *then* the close (never the close first);
/// the loopback client hears the flip as a state broadcast.
#[tokio::test]
async fn a_remote_originator_gets_its_ack_then_the_close() {
    let daemon = start_daemon().await;
    let mut local = connected(daemon.addr()).await;
    set_lan_access(&mut local, true).await;
    wait_connectable(lan_addr(&daemon)).await;
    let mut remote = connected(lan_addr(&daemon)).await;

    send_json(
        &mut remote,
        &serde_json::json!({ "cmd": "set_lan_access", "request_id": "rq-off", "on": false }),
    )
    .await;
    // Strict order on the originator's stream: pub/sub events may
    // interleave, but the ack must land before any close.
    {
        use futures_util::StreamExt;
        loop {
            let message = tokio::time::timeout(std::time::Duration::from_secs(5), remote.next())
                .await
                .expect("a reply within 5s");
            match message {
                Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) => {
                    let frame: serde_json::Value = serde_json::from_str(&text).expect("json");
                    if frame["type"] == "state" || frame["type"] == "vis" {
                        continue;
                    }
                    assert_eq!(frame["type"], "ack", "got {frame}");
                    assert_eq!(frame["request_id"], "rq-off");
                    break;
                }
                other => panic!("severed before the ack: {other:?}"),
            }
        }
    }
    assert_severed(&mut remote).await;

    let broadcast = recv_state(&mut local).await;
    assert_eq!(broadcast["snapshot"]["lan_access"], false);
}

/// Behavior 6: the flip rides the Cascade's write law — `config.toml`
/// holds `lan_access = true` (and nothing once back at the default) —
/// and a restart reopens the LAN door from persisted state.
#[tokio::test]
async fn the_flip_persists_and_a_restart_reopens_the_lan_door() {
    let dir = fixture_dir();
    let config = dir.path().join("data").join("config.toml");
    let (daemon, _stub) = start_over(&dir).await;
    let mut local = connected(daemon.addr()).await;

    set_lan_access(&mut local, true).await;
    assert_config_becomes(&config, "lan_access = true\n").await;

    daemon.shutdown().await;
    let (daemon, stub) = start_over(&dir).await;
    assert_eq!(
        daemon.addr().ip(),
        std::net::IpAddr::V4(TEST_LAN_IP),
        "the boot-time door is the LAN one"
    );

    // A remote device toggles off: severed after its ack; the write
    // law drops the key; the loopback door serves again.
    let daemon = TestDaemon {
        handle: daemon,
        stub,
        dir,
    };
    let mut remote = connected(daemon.addr()).await;
    set_lan_access(&mut remote, false).await;
    assert_severed(&mut remote).await;
    assert_config_becomes(&config, "").await;
    wait_connectable(loopback_addr(&daemon)).await;
    let _ = connected(loopback_addr(&daemon)).await;
}

/// Behavior 7: a hand-edited `lan_access` arrives live through the
/// config watcher — on opens the door, off severs and closes it, no
/// WS command anywhere.
#[tokio::test]
async fn a_hand_edited_lan_access_arrives_live() {
    let daemon = start_daemon().await;
    let config = daemon.dir.path().join("data").join("config.toml");
    let mut local = connected(daemon.addr()).await;

    std::fs::write(&config, "lan_access = true\n").expect("hand-edit lands");
    let snapshot = recv_state(&mut local).await;
    assert_eq!(snapshot["snapshot"]["lan_access"], true);
    wait_connectable(lan_addr(&daemon)).await;
    let mut remote = connected(lan_addr(&daemon)).await;

    std::fs::write(&config, "").expect("hand-edit lands");
    let snapshot = recv_state(&mut local).await;
    assert_eq!(snapshot["snapshot"]["lan_access"], false);
    assert_severed(&mut remote).await;
    wait_refused(lan_addr(&daemon)).await;
}

/// Behavior 8: revocation covers a kept-alive LAN-door socket — after
/// the off-flip it cannot complete another request: the rebind's abort
/// makes hyper close idle connections, and one that slips a request in
/// first meets the door gate's `403`. Either way, never a `200`.
#[tokio::test]
async fn a_lingering_lan_connection_cannot_request_after_off() {
    let daemon = start_daemon().await;
    let mut local = connected(daemon.addr()).await;
    set_lan_access(&mut local, true).await;
    wait_connectable(lan_addr(&daemon)).await;

    let mut stream = tokio::net::TcpStream::connect(lan_addr(&daemon))
        .await
        .expect("connect while on");
    assert_eq!(
        keep_alive_get(&mut stream, lan_addr(&daemon)).await,
        Some(200),
        "the socket serves while on"
    );

    set_lan_access(&mut local, false).await;

    // The gate flips before the ack, so a served request can only 403;
    // `None` means hyper's close beat the request to the socket.
    let outcome = keep_alive_get(&mut stream, lan_addr(&daemon)).await;
    assert!(
        matches!(outcome, None | Some(403)),
        "the socket must be dead or refused, got {outcome:?}"
    );
}

/// One `GET /` on an already-open connection, kept alive; the status
/// code after draining the body (Content-Length), or `None` when the
/// server closed the socket instead of answering.
async fn keep_alive_get(stream: &mut tokio::net::TcpStream, addr: SocketAddr) -> Option<u16> {
    let request = format!("GET / HTTP/1.1\r\nHost: {addr}\r\n\r\n");
    if stream.write_all(request.as_bytes()).await.is_err() {
        return None;
    }
    let mut response = Vec::new();
    let header_end = loop {
        let mut chunk = [0_u8; 1024];
        match stream.read(&mut chunk).await {
            Ok(read) if read > 0 => response.extend_from_slice(&chunk[..read]),
            _ => return None,
        }
        if let Some(position) = response.windows(4).position(|w| w == b"\r\n\r\n") {
            break position + 4;
        }
    };
    let head = String::from_utf8_lossy(&response[..header_end]).to_string();
    let content_length: usize = head
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length:")?
                .trim()
                .parse()
                .ok()
        })
        .expect("content-length header");
    while response.len() < header_end + content_length {
        let mut chunk = [0_u8; 1024];
        match stream.read(&mut chunk).await {
            Ok(read) if read > 0 => response.extend_from_slice(&chunk[..read]),
            _ => return None,
        }
    }
    head.split_whitespace()
        .nth(1)
        .expect("status code")
        .parse()
        .ok()
}

/// Behavior 9: a bind failure names the address it actually tried —
/// the loopback door by default, the LAN door when `lan_access`
/// resolves on at startup.
#[tokio::test]
async fn a_bind_failure_names_the_address_it_tried() {
    let dir = fixture_dir();

    // Occupy a loopback port, then ask the daemon for exactly it.
    let squatter = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).expect("bind");
    let port = squatter.local_addr().expect("addr").port();
    let mut config = config_for(&dir);
    config.port = port;
    let error = match ddp_daemon::Daemon::start(
        config,
        std::sync::Arc::new(ddp_engine::StubBackend::new()),
    )
    .await
    {
        Err(error) => error.to_string(),
        Ok(_) => panic!("the occupied port must refuse"),
    };
    assert!(
        error.contains(&format!("bind 127.0.0.1:{port}")),
        "must name the loopback door: {error}"
    );

    // With `lan_access` resolved on, the daemon tries the LAN door —
    // and says so.
    std::fs::create_dir_all(dir.path().join("data")).expect("config dir");
    std::fs::write(
        dir.path().join("data").join("config.toml"),
        "lan_access = true\n",
    )
    .expect("config.toml");
    let squatter = std::net::TcpListener::bind((TEST_LAN_IP, 0)).expect("bind");
    let port = squatter.local_addr().expect("addr").port();
    let mut config = config_for(&dir);
    config.port = port;
    let error = match ddp_daemon::Daemon::start(
        config,
        std::sync::Arc::new(ddp_engine::StubBackend::new()),
    )
    .await
    {
        Err(error) => error.to_string(),
        Ok(_) => panic!("the occupied LAN door must refuse"),
    };
    assert!(
        error.contains(&format!("bind 127.0.0.2:{port}")),
        "must name the LAN door: {error}"
    );
}

/// The root-scalar grammar (reply law): a malformed `set_lan_access`
/// is refused as `INVALID_REQUEST` echoing the id, and a no-op flip
/// still acks.
#[tokio::test]
async fn set_lan_access_follows_the_reply_law() {
    let daemon = start_daemon().await;
    let mut ws = connected(daemon.addr()).await;

    send_json(
        &mut ws,
        &serde_json::json!({ "cmd": "set_lan_access", "request_id": "rq-bad", "on": 5 }),
    )
    .await;
    let reply = recv_json(&mut ws).await;
    assert_eq!(reply["type"], "error");
    assert_eq!(reply["code"], "INVALID_REQUEST");
    assert_eq!(reply["request_id"], "rq-bad");

    // Restating the current value: acked, nothing rebinds.
    set_lan_access(&mut ws, false).await;
    wait_refused(lan_addr(&daemon)).await;
}
