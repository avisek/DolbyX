//! Behaviors (issue #70): the LAN access toggle — `lan_access` rides
//! the Cascade, `set_lan_access` follows the root-scalar grammar and
//! the reply law, and each real flip rebinds the one listener between
//! `127.0.0.1` and `0.0.0.0` live (ADR-0012). Tests bind the
//! production target and reach it through the machine's own routable
//! address — same-host traffic bypasses inbound firewall filtering —
//! so the accepted connection is genuinely non-loopback; routable
//! tests skip at runtime on a routeless host. Severing established
//! LAN connections on off is 3/5 — deliberately not asserted here.

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

/// Established connections survive a flip in both directions — the
/// rebind swaps the accept task only, and loopback clients are never
/// disturbed. The LAN client's off-survival is transitional: severing
/// is 3/5, which deliberately inverts it.
#[tokio::test]
async fn established_connections_survive_both_flips() {
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

    let (mut lan_ws, _) = connected_via(ip, port).await;

    let reply = set_lan_access(&mut originator, false, "rq-off").await;
    assert_eq!(reply["type"], "ack");
    assert_eq!(
        recv_state(&mut observer).await["snapshot"]["lan_access"],
        false,
        "the loopback observer lives through the off-flip too"
    );

    // Round-trip on every surviving socket proves the connection —
    // not just the TCP half — is alive.
    common::send_json(
        &mut originator,
        &serde_json::json!({ "cmd": "get_state", "request_id": "rq-orig" }),
    )
    .await;
    assert_eq!(recv_state(&mut originator).await["snapshot"]["power"], true);
    // Transitional (3/5 inverts): the established LAN connection keeps
    // working after off until severing lands.
    common::send_json(
        &mut lan_ws,
        &serde_json::json!({ "cmd": "get_state", "request_id": "rq-lan" }),
    )
    .await;
    assert_eq!(
        recv_state(&mut lan_ws).await["snapshot"]["lan_access"],
        false
    );
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
