//! Behaviors (issues #70 + #75): the LAN access toggle — `lan_access`
//! rides the Cascade, `set_lan_access` follows the root-scalar grammar
//! and the reply law, each real flip rebinds the one listener between
//! `127.0.0.1` and `0.0.0.0` live, and off severs every established
//! non-loopback connection after the rebind — loopback never, the
//! originator's ack first (ADR-0012). Tests bind the production target
//! and reach it through the machine's own routable address — same-host
//! traffic bypasses inbound firewall filtering — so the accepted
//! connection is genuinely non-loopback; routable tests skip at
//! runtime on a routeless host.

mod common;

use std::net::{Ipv4Addr, SocketAddr};

use common::{
    WsClient, assert_config_becomes, bootstrap_json, connected, http_get, recv_json, recv_state,
    start_daemon, try_recv_json, ws_connect,
};

/// The default-route interface's IPv4 — the address a phone would dial
/// — or `None` on a routeless host (the UDP connect only picks a
/// route; no packet leaves).
fn routable_ipv4() -> Option<Ipv4Addr> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect(("8.8.8.8", 80)).ok()?;
    match socket.local_addr().ok()? {
        SocketAddr::V4(addr) if !addr.ip().is_loopback() => Some(*addr.ip()),
        _ => None,
    }
}

/// The specific address a test holds to make the daemon's `0.0.0.0`
/// bind fail while loopback stays bindable: any second specific
/// address conflicts with the wildcard on Unix; Windows treats
/// wildcard and specific as unique, so the wildcard itself is held.
const HOLDER: Ipv4Addr = if cfg!(windows) {
    Ipv4Addr::UNSPECIFIED
} else {
    Ipv4Addr::new(127, 0, 0, 2)
};

/// Issues `set_lan_access` and returns the daemon's reply frame (`ack`
/// or `error`), skipping pub/sub events — promise-style (ADR-0005).
async fn set_lan_access(ws: &mut WsClient, on: bool, request_id: &str) -> serde_json::Value {
    common::send_json(
        ws,
        &serde_json::json!({ "cmd": "set_lan_access", "request_id": request_id, "on": on }),
    )
    .await;
    loop {
        let frame = recv_json(ws).await;
        if frame["type"] == "state" || frame["type"] == "vis" {
            continue;
        }
        return frame;
    }
}

/// Asserts nothing listens at `addr`: the connect itself must fail —
/// nothing accepts (a paranoid middlebox dropping instead of
/// refusing surfaces as the timeout).
async fn assert_refused(addr: SocketAddr) {
    let connect = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        tokio::net::TcpStream::connect(addr),
    )
    .await;
    assert!(
        !matches!(connect, Ok(Ok(_))),
        "{addr} accepted a connection while it must refuse"
    );
}

/// Opens `/ws` via an explicit host (the routable address) and
/// consumes the snapshot-on-connect, returning it with the client.
async fn connected_via(ip: Ipv4Addr, port: u16) -> (WsClient, serde_json::Value) {
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{ip}:{port}/ws"))
        .await
        .expect("ws connect via the routable address");
    let hello = recv_json(&mut ws).await;
    assert_eq!(hello["type"], "state");
    (ws, hello)
}

/// Opens a fresh loopback connection and returns its hello snapshot —
/// proof loopback (still) serves, and of what it says.
async fn loopback_snapshot(addr: SocketAddr) -> serde_json::Value {
    let mut ws = ws_connect(addr).await;
    let hello = recv_json(&mut ws).await;
    assert_eq!(hello["type"], "state");
    hello["snapshot"].clone()
}

/// The tracer bullet: flip on ⇒ the routable address serves HTTP and
/// WS (a genuinely non-loopback accepted connection — the production
/// `0.0.0.0` target, no firewall rule, no fake alias); flip off ⇒ the
/// routable address refuses again while loopback serves throughout.
#[tokio::test]
async fn the_toggle_opens_and_closes_the_lan() {
    let Some(ip) = routable_ipv4() else {
        eprintln!("skipped: no routable IPv4 interface");
        return;
    };
    let daemon = start_daemon().await;
    let port = daemon.addr().port();
    let lan = SocketAddr::from((ip, port));

    // Shipped default off: this PC only.
    assert_refused(lan).await;

    let mut ws = connected(daemon.addr()).await;
    let reply = set_lan_access(&mut ws, true, "rq-on").await;
    assert_eq!(reply["type"], "ack", "flip on must ack, got {reply}");

    let (status, body) = http_get(lan, "/").await;
    assert_eq!(status, 200, "the LAN device gets the UI");
    assert_eq!(bootstrap_json(&body)["state"]["lan_access"], true);
    let (_lan_ws, hello) = connected_via(ip, port).await;
    assert_eq!(hello["snapshot"]["lan_access"], true);

    let reply = set_lan_access(&mut ws, false, "rq-off").await;
    assert_eq!(reply["type"], "ack", "flip off must ack, got {reply}");

    assert_refused(lan).await;
    // Loopback serves as ever — a fresh connection, not a survivor.
    assert_eq!(loopback_snapshot(daemon.addr()).await["lan_access"], false);
}

/// Asserts the daemon severs this connection: the stream ends — close
/// frame, error, or EOF — within 5 s. Data frames already in flight
/// (a state broadcast racing the sever) are tolerated on the way out.
async fn assert_severed(ws: &mut WsClient, who: &str) {
    use futures_util::StreamExt;
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            match ws.next().await {
                None | Some(Err(_) | Ok(tokio_tungstenite::tungstenite::Message::Close(_))) => {
                    return;
                }
                Some(Ok(_)) => {}
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{who} must be severed within 5s"));
}

/// The off-flip severs every established non-loopback WebSocket —
/// revoking access in use, not just future connections — while every
/// loopback connection (the originator included) lives through both
/// flips untouched, and a severed device cannot come back: the rebind
/// already closed the door it would knock on.
#[tokio::test]
async fn the_off_flip_severs_lan_websockets_and_spares_loopback() {
    let Some(ip) = routable_ipv4() else {
        eprintln!("skipped: no routable IPv4 interface");
        return;
    };
    let daemon = start_daemon().await;
    let port = daemon.addr().port();

    let mut originator = connected(daemon.addr()).await;
    let mut observer = connected(daemon.addr()).await;

    let reply = set_lan_access(&mut originator, true, "rq-on").await;
    assert_eq!(reply["type"], "ack");
    assert_eq!(
        recv_state(&mut observer).await["snapshot"]["lan_access"],
        true,
        "the loopback observer lives through the on-flip and hears it"
    );

    // "Every established non-loopback connection": two, not one.
    let (mut lan_a, _) = connected_via(ip, port).await;
    let (mut lan_b, _) = connected_via(ip, port).await;

    let reply = set_lan_access(&mut originator, false, "rq-off").await;
    assert_eq!(reply["type"], "ack");

    assert_severed(&mut lan_a, "the first LAN websocket").await;
    assert_severed(&mut lan_b, "the second LAN websocket").await;
    // A severed device stays out: its reconnect finds the door shut.
    assert_refused(SocketAddr::from((ip, port))).await;

    assert_eq!(
        recv_state(&mut observer).await["snapshot"]["lan_access"],
        false,
        "the loopback observer lives through the off-flip too"
    );
    // Round-trip on the loopback originator proves the connection —
    // not just the TCP half — is alive.
    common::send_json(
        &mut originator,
        &serde_json::json!({ "cmd": "get_state", "request_id": "rq-orig" }),
    )
    .await;
    assert_eq!(recv_state(&mut originator).await["snapshot"]["power"], true);
}

/// One `GET /` on an already-open keep-alive socket: `Some((status,
/// body))` when a full response arrives, `None` when the connection is
/// dead (write refused, EOF, reset, or silence past the deadline).
async fn keep_alive_get(
    stream: &mut tokio::net::TcpStream,
    host: SocketAddr,
) -> Option<(u16, String)> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let request = format!("GET / HTTP/1.1\r\nHost: {host}\r\nConnection: keep-alive\r\n\r\n");
    stream.write_all(request.as_bytes()).await.ok()?;
    let mut response = Vec::new();
    loop {
        let mut chunk = [0u8; 4096];
        let read = tokio::time::timeout(std::time::Duration::from_secs(2), stream.read(&mut chunk))
            .await
            .ok()?
            .ok()?;
        if read == 0 {
            return None;
        }
        response.extend_from_slice(&chunk[..read]);
        let text = String::from_utf8_lossy(&response);
        let Some((head, body)) = text.split_once("\r\n\r\n") else {
            continue;
        };
        let length: usize = head
            .lines()
            .find_map(|line| {
                line.to_ascii_lowercase()
                    .strip_prefix("content-length:")
                    .map(|value| value.trim().parse().expect("numeric content-length"))
            })
            .expect("keep-alive response carries content-length");
        if body.len() < length {
            continue;
        }
        let status = head
            .split_whitespace()
            .nth(1)
            .expect("status code")
            .parse()
            .expect("numeric status");
        return Some((status, body.to_string()));
    }
}

/// Off closes lingering keep-alive HTTP sockets: a LAN browser cannot
/// reload the UI on a connection it already holds — its next request
/// finds the socket dead — while a loopback keep-alive socket serves
/// straight through the flip.
#[tokio::test]
async fn the_off_flip_closes_lingering_keep_alive_http_sockets() {
    let Some(ip) = routable_ipv4() else {
        eprintln!("skipped: no routable IPv4 interface");
        return;
    };
    let daemon = start_daemon().await;
    let port = daemon.addr().port();
    let lan = SocketAddr::from((ip, port));
    let local = daemon.addr();

    // The loopback socket opens before the on-flip: "never severed, in
    // either direction" covers idle keep-alive sockets too.
    let mut local_sock = tokio::net::TcpStream::connect(local)
        .await
        .expect("local connect");
    let (status, _) = keep_alive_get(&mut local_sock, local)
        .await
        .expect("the loopback keep-alive socket serves while off");
    assert_eq!(status, 200);

    let mut ws = connected(daemon.addr()).await;
    let reply = set_lan_access(&mut ws, true, "rq-on").await;
    assert_eq!(reply["type"], "ack");

    // Both sockets complete one request while on, then linger open.
    let mut lan_sock = tokio::net::TcpStream::connect(lan)
        .await
        .expect("lan connect");
    let (status, _) = keep_alive_get(&mut lan_sock, lan)
        .await
        .expect("the LAN keep-alive socket serves while on");
    assert_eq!(status, 200);
    let (status, _) = keep_alive_get(&mut local_sock, local)
        .await
        .expect("the loopback keep-alive socket lives through the on-flip");
    assert_eq!(status, 200);

    let reply = set_lan_access(&mut ws, false, "rq-off").await;
    assert_eq!(reply["type"], "ack");

    assert!(
        keep_alive_get(&mut lan_sock, lan).await.is_none(),
        "a LAN browser must not reload the UI on a connection it already holds"
    );
    let (status, body) = keep_alive_get(&mut local_sock, local)
        .await
        .expect("the loopback keep-alive socket lives through the flip");
    assert_eq!(status, 200);
    assert_eq!(bootstrap_json(&body)["state"]["lan_access"], false);
}

/// The reply law holds even when the reply severs the replier: a LAN
/// device flipping off hears its own `ack` — the flip visibly took —
/// and then the close. Originator suppression means nothing else is
/// due on that socket: the post-ack stream is exactly the severing.
#[tokio::test]
async fn a_lan_originator_hears_its_ack_then_the_close() {
    let Some(ip) = routable_ipv4() else {
        eprintln!("skipped: no routable IPv4 interface");
        return;
    };
    let daemon = start_daemon().await;
    let port = daemon.addr().port();

    let mut loopback = connected(daemon.addr()).await;
    let reply = set_lan_access(&mut loopback, true, "rq-on").await;
    assert_eq!(reply["type"], "ack");

    // The phone itself flips the toggle off.
    let (mut phone, _) = connected_via(ip, port).await;
    let reply = set_lan_access(&mut phone, false, "rq-phone-off").await;
    assert_eq!(
        (reply["type"].as_str(), reply["request_id"].as_str()),
        (Some("ack"), Some("rq-phone-off")),
        "the ack lands before the close: {reply}"
    );
    assert_severed(&mut phone, "the phone that flipped off").await;
}

/// The reply law + originator suppression, loopback-only (no routable
/// interface required — `0.0.0.0` binds regardless): the originator
/// hears exactly its `ack`, the other connection hears exactly the
/// `state` broadcast; a malformed frame is `INVALID_REQUEST` like any
/// other command's.
#[tokio::test]
async fn the_originator_gets_the_ack_and_others_get_the_broadcast() {
    let daemon = start_daemon().await;
    let mut originator = connected(daemon.addr()).await;
    let mut observer = connected(daemon.addr()).await;

    common::send_json(
        &mut originator,
        &serde_json::json!({ "cmd": "set_lan_access", "request_id": "rq-1", "on": true }),
    )
    .await;
    let reply = recv_json(&mut originator).await;
    assert_eq!(
        (reply["type"].as_str(), reply["request_id"].as_str()),
        (Some("ack"), Some("rq-1")),
        "the ack is the originator's only feedback: {reply}"
    );
    assert!(
        try_recv_json(&mut originator, 300).await.is_none(),
        "the originator is excluded from the state broadcast (ADR-0005)"
    );
    assert_eq!(
        recv_state(&mut observer).await["snapshot"]["lan_access"],
        true
    );

    // Root-scalar grammar: a frame without `on` fails serde and
    // settles promise-style as INVALID_REQUEST.
    common::send_json(
        &mut originator,
        &serde_json::json!({ "cmd": "set_lan_access", "request_id": "rq-2" }),
    )
    .await;
    let reply = recv_json(&mut originator).await;
    assert_eq!(reply["code"], "INVALID_REQUEST");
    assert_eq!(reply["request_id"], "rq-2");
}

/// A redundant set — same value — acks under the reply law and leaves
/// everything untouched: no broadcast, no persistence write, and the
/// listener never rebinds.
#[tokio::test]
async fn a_redundant_set_acks_and_touches_nothing() {
    let daemon = start_daemon().await;
    let mut originator = connected(daemon.addr()).await;
    let mut observer = connected(daemon.addr()).await;

    let reply = set_lan_access(&mut originator, false, "rq-same").await;
    assert_eq!(reply["type"], "ack");
    assert_eq!(reply["request_id"], "rq-same");
    assert!(
        try_recv_json(&mut observer, 300).await.is_none(),
        "a no-op fans nothing out"
    );
    let config = daemon.dir.path().join("data").join("config.toml");
    assert_eq!(
        std::fs::read_to_string(config).expect("config readable"),
        "",
        "nothing diverged, nothing stored"
    );
}

/// The write law over the flip: on diverges from the shipped default
/// and lands as the one root key; off returns to the default and the
/// key drops — plus a restart resumes the persisted value (startup
/// binds per state, asserted loopback-side here; the routable side is
/// `startup_binds_the_lan_target_when_persisted_on`).
#[tokio::test]
async fn the_flip_persists_by_the_write_law() {
    let daemon = start_daemon().await;
    let config = daemon.dir.path().join("data").join("config.toml");
    let mut ws = connected(daemon.addr()).await;

    let reply = set_lan_access(&mut ws, true, "rq-on").await;
    assert_eq!(reply["type"], "ack");
    assert_config_becomes(&config, "lan_access = true\n").await;

    let reply = set_lan_access(&mut ws, false, "rq-off").await;
    assert_eq!(reply["type"], "ack");
    assert_config_becomes(&config, "").await;
}

/// A failed rebind (the port held at the new target) replies
/// `LAN_BIND_FAILED`, re-binds the previous address, and leaves the
/// store exactly where it was — no broadcast, nothing persisted; once
/// the holder releases, the same flip succeeds.
#[tokio::test]
async fn a_failed_rebind_replies_lan_bind_failed_and_nothing_moves() {
    let daemon = start_daemon().await;
    let port = daemon.addr().port();
    let holder = std::net::TcpListener::bind((HOLDER, port)).expect("hold the port");

    let mut originator = connected(daemon.addr()).await;
    let mut observer = connected(daemon.addr()).await;

    let reply = set_lan_access(&mut originator, true, "rq-blocked").await;
    assert_eq!(reply["type"], "error", "got {reply}");
    assert_eq!(reply["code"], "LAN_BIND_FAILED");
    assert_eq!(reply["request_id"], "rq-blocked");

    assert!(
        try_recv_json(&mut observer, 300).await.is_none(),
        "the store never moved — nothing to broadcast"
    );
    // The previous address is re-bound: loopback serves a fresh
    // connection, and its snapshot still says off.
    assert_eq!(loopback_snapshot(daemon.addr()).await["lan_access"], false);
    let config = daemon.dir.path().join("data").join("config.toml");
    assert_eq!(
        std::fs::read_to_string(config).expect("config readable"),
        "",
        "a refused flip persists nothing"
    );

    drop(holder);
    let reply = set_lan_access(&mut originator, true, "rq-retry").await;
    assert_eq!(reply["type"], "ack", "the flip works once the port frees");
}

/// Startup binds per the persisted value: a config stating
/// `lan_access = true` serves the routable address from the first
/// request, no flip needed.
#[tokio::test]
async fn startup_binds_the_lan_target_when_persisted_on() {
    let Some(ip) = routable_ipv4() else {
        eprintln!("skipped: no routable IPv4 interface");
        return;
    };
    let dir = common::fixture_dir();
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).expect("create config dir");
    std::fs::write(data.join("config.toml"), "lan_access = true\n").expect("persist on");

    let (daemon, _stub) = common::start_over(&dir).await;
    let port = daemon.addr().port();

    let (status, body) = http_get(SocketAddr::from((ip, port)), "/").await;
    assert_eq!(status, 200);
    assert_eq!(bootstrap_json(&body)["state"]["lan_access"], true);
    // Loopback serves alongside — 0.0.0.0 covers it.
    let mut ws = ws_connect(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).await;
    assert_eq!(recv_json(&mut ws).await["snapshot"]["lan_access"], true);

    daemon.shutdown().await;
}

/// A startup bind failure keeps the refuse-to-start policy: with the
/// persisted value on and the port held at the wildcard target,
/// `Daemon::start` errs naming the target — never a silent loopback
/// downgrade.
#[tokio::test]
async fn a_startup_bind_failure_refuses_to_start() {
    let holder = std::net::TcpListener::bind((HOLDER, 0)).expect("hold a port");
    let port = holder.local_addr().expect("holder addr").port();

    let dir = common::fixture_dir();
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).expect("create config dir");
    std::fs::write(data.join("config.toml"), "lan_access = true\n").expect("persist on");

    let mut config = common::config_for(&dir);
    config.port = port;
    let started =
        ddp_daemon::Daemon::start(config, std::sync::Arc::new(ddp_engine::StubBackend::new()))
            .await;
    let Err(error) = started else {
        panic!("the held port must refuse startup");
    };
    let error = error.to_string();
    assert!(
        error.contains(&format!("bind 0.0.0.0:{port}")),
        "the error names the LAN target: {error}"
    );
    drop(holder);
}

/// The watcher path severs like the command path (issue #75): a
/// hand-edit back to off evicts the established LAN websocket and the
/// lingering LAN keep-alive socket both — there is no route into off
/// that leaves a LAN device connected.
#[tokio::test]
async fn a_hand_edit_to_off_severs_lan_connections_too() {
    let Some(ip) = routable_ipv4() else {
        eprintln!("skipped: no routable IPv4 interface");
        return;
    };
    let daemon = start_daemon().await;
    let port = daemon.addr().port();
    let lan = SocketAddr::from((ip, port));
    let config = daemon.dir.path().join("data").join("config.toml");
    let mut ws = connected(daemon.addr()).await;

    std::fs::write(&config, "lan_access = true\n").expect("hand-edit lands");
    assert_eq!(recv_state(&mut ws).await["snapshot"]["lan_access"], true);

    let (mut lan_ws, _) = connected_via(ip, port).await;
    let mut lan_sock = tokio::net::TcpStream::connect(lan)
        .await
        .expect("lan connect");
    let (status, _) = keep_alive_get(&mut lan_sock, lan)
        .await
        .expect("the LAN keep-alive socket serves while on");
    assert_eq!(status, 200);

    std::fs::write(&config, "").expect("hand-edit lands");
    assert_eq!(recv_state(&mut ws).await["snapshot"]["lan_access"], false);

    assert_severed(&mut lan_ws, "the LAN websocket on a hand-edit to off").await;
    assert!(
        keep_alive_get(&mut lan_sock, lan).await.is_none(),
        "the hand-edit closes lingering keep-alive sockets too"
    );
    assert_refused(lan).await;
}

/// The config watcher path (ADR-0007): a hand-edited `lan_access`
/// arrives live — the listener rebinds and every client hears the new
/// snapshot; when the rebind fails, the previous address *and* scalar
/// stay, silently (logged, no reply — ADR-0012).
#[tokio::test]
async fn a_hand_edit_flips_the_listener_live() {
    let daemon = start_daemon().await;
    let port = daemon.addr().port();
    let config = daemon.dir.path().join("data").join("config.toml");
    let mut ws = connected(daemon.addr()).await;

    std::fs::write(&config, "lan_access = true\n").expect("hand-edit lands");
    assert_eq!(
        recv_state(&mut ws).await["snapshot"]["lan_access"],
        true,
        "the reload broadcasts to every client"
    );
    if let Some(ip) = routable_ipv4() {
        let (_lan_ws, hello) = connected_via(ip, port).await;
        assert_eq!(hello["snapshot"]["lan_access"], true);
    }

    // Back off, then a blocked hand-edit: the watcher's fallback keeps
    // the previous address and the previous scalar, with no reply
    // surface — the broadcast snapshot still says off.
    std::fs::write(&config, "").expect("hand-edit lands");
    assert_eq!(recv_state(&mut ws).await["snapshot"]["lan_access"], false);
    let holder = std::net::TcpListener::bind((HOLDER, port)).expect("hold the port");
    std::fs::write(&config, "lan_access = true\n").expect("hand-edit lands");
    assert_eq!(
        recv_state(&mut ws).await["snapshot"]["lan_access"],
        false,
        "a failed watcher rebind keeps the scalar where it was"
    );
    assert_eq!(loopback_snapshot(daemon.addr()).await["lan_access"], false);
    drop(holder);
}
