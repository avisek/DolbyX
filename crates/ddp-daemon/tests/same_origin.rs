//! Behaviors (issue #69): same-origin hardening (ADR-0012), independent
//! of the LAN access toggle. A WS upgrade whose `Origin` host differs
//! from the `Host` host is refused — WS is CORS-exempt, so any webpage
//! that can route to the daemon could otherwise command it. A `Host`
//! that is neither an IP literal nor `localhost` is refused on both
//! routes — a rebound page's `Origin` agrees with its `Host`, so only
//! the `Host` check can see DNS rebinding. No-`Origin` clients pass
//! unchanged — every other suite is that proof (the harness clients
//! send no `Origin`).

mod common;

use std::net::SocketAddr;

use common::{recv_json, start_daemon};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite;
use tungstenite::client::IntoClientRequest;

/// One raw request; returns the response's status code — for
/// `Host`-manipulation cases no real client expresses. Reads the status
/// line only: an accepted upgrade keeps the stream open.
async fn raw_status(addr: SocketAddr, request: &str) -> u16 {
    let mut stream = tokio::net::TcpStream::connect(addr).await.expect("connect");
    stream
        .write_all(request.as_bytes())
        .await
        .expect("send request");
    let mut response = Vec::new();
    while !response.windows(2).any(|pair| pair == b"\r\n") {
        let mut chunk = [0_u8; 256];
        let read = stream.read(&mut chunk).await.expect("read response");
        assert!(read > 0, "closed before a status line: {response:?}");
        response.extend_from_slice(&chunk[..read]);
    }
    String::from_utf8_lossy(&response)
        .split_whitespace()
        .nth(1)
        .expect("status code")
        .parse()
        .expect("numeric status")
}

/// A raw `/ws` upgrade request under an arbitrary `Host` (+ optional
/// `Origin`).
fn raw_upgrade(host: &str, origin: Option<&str>) -> String {
    let origin = origin.map_or_else(String::new, |origin| format!("Origin: {origin}\r\n"));
    format!(
        "GET /ws HTTP/1.1\r\nHost: {host}\r\n{origin}\
         Upgrade: websocket\r\nConnection: Upgrade\r\n\
         Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
    )
}

/// A rebound DNS name is refused on both routes: the attacker's record
/// points a real name at the daemon, so the browser sends that name as
/// `Host` — and on the WS its `Origin` *agrees* with it, sailing past
/// the cross-origin check. No DNS name legitimately points here (no
/// mDNS — epic #67), so any non-IP, non-`localhost` `Host` is hostile.
#[tokio::test]
async fn a_rebound_dns_name_host_is_refused_on_both_routes() {
    let daemon = start_daemon().await;
    let port = daemon.addr().port();
    let host = format!("attacker.example:{port}");

    let index = format!("GET / HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
    assert_eq!(raw_status(daemon.addr(), &index).await, 403, "GET /");

    let origin = format!("http://{host}");
    let upgrade = raw_upgrade(&host, Some(&origin));
    assert_eq!(raw_status(daemon.addr(), &upgrade).await, 403, "GET /ws");
}

/// Every way a legit client addresses the daemon passes: `localhost`,
/// an IPv6 literal (bracketed, per the header syntax), and the LAN IP a
/// phone will send once the toggle (#70) is on. `127.0.0.1` is what
/// every other suite sends. The header alone is judged — the daemon
/// need not be reachable *at* that address.
#[tokio::test]
async fn ip_literal_and_localhost_hosts_pass() {
    let daemon = start_daemon().await;
    let port = daemon.addr().port();
    for host in [
        format!("localhost:{port}"),
        format!("[::1]:{port}"),
        format!("192.168.1.5:{port}"),
    ] {
        let index = format!("GET / HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
        assert_eq!(raw_status(daemon.addr(), &index).await, 200, "`{host}`");
    }
}

/// A real-protocol upgrade request for the daemon's `/ws`, carrying an
/// `Origin` — as a browser sends it (scripts and tests send none).
fn ws_request(addr: SocketAddr, origin: &str) -> tungstenite::handshake::client::Request {
    let mut request = format!("ws://{addr}/ws")
        .into_client_request()
        .expect("ws request");
    request
        .headers_mut()
        .insert("Origin", origin.parse().expect("origin header value"));
    request
}

/// A cross-host `Origin` on the upgrade is refused before it completes.
/// Hosts compare textually — `localhost` never equals `127.0.0.1`
/// (resolving names would reopen the rebinding hole) — and an opaque
/// origin (`null`) matches nothing.
#[tokio::test]
async fn a_cross_host_origin_ws_upgrade_is_refused() {
    let daemon = start_daemon().await;
    let port = daemon.addr().port();
    for origin in [
        "http://evil.example".to_string(),
        format!("http://localhost:{port}"),
        "null".to_string(),
    ] {
        let error = tokio_tungstenite::connect_async(ws_request(daemon.addr(), &origin))
            .await
            .expect_err(&format!("`{origin}` must be refused"));
        let tungstenite::Error::Http(response) = error else {
            panic!("`{origin}`: expected an HTTP refusal, got {error}");
        };
        assert_eq!(response.status(), 403, "`{origin}`");
    }
}

/// The daemon-served UI passes: its page origin is the daemon itself,
/// so `Origin`'s host equals `Host`'s and the upgrade serves the
/// snapshot as ever.
#[tokio::test]
async fn the_daemon_served_uis_own_origin_upgrades_and_snapshots() {
    let daemon = start_daemon().await;
    let origin = format!("http://{}", daemon.addr());
    let (mut ws, _) = tokio_tungstenite::connect_async(ws_request(daemon.addr(), &origin))
        .await
        .expect("the UI's own origin upgrades");
    assert_eq!(recv_json(&mut ws).await["type"], "state");
}

/// The check is on the *host*, not the authority (issue #69): an
/// `Origin` on another port of the same host passes — cross-*host* is
/// the threat, and the dev loop pairs ports on one host.
#[tokio::test]
async fn an_origin_on_another_port_of_the_same_host_passes() {
    let daemon = start_daemon().await;
    let (mut ws, _) =
        tokio_tungstenite::connect_async(ws_request(daemon.addr(), "http://127.0.0.1:1"))
            .await
            .expect("same host, other port upgrades");
    assert_eq!(recv_json(&mut ws).await["type"], "state");
}
