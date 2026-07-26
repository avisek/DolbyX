//! Shared harness: an in-process daemon on an ephemeral port against a
//! tempdir, plus raw HTTP/WS clients. Mock policy (issue #12): nothing
//! past the `Engine` trait — HTTP and WS run real, persistence hits a
//! real tempdir.

// Each tests/*.rs target compiles this module and uses a subset of it.
#![allow(dead_code)]

pub mod plugin;

use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;

use ddp_daemon::{Daemon, DaemonConfig};
use ddp_engine::StubBackend;
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// A minimal stand-in for the built UI: exactly the placeholder contract
/// `ui/dev.html` ships.
pub const UI_HTML: &str =
    "<!doctype html>\n<html><head><!--BOOTSTRAP--></head><body></body></html>\n";

/// Rich's 20-band IEQ target curve, verbatim from the shipped
/// `defaults.toml` (`docs/ddp/05`) — the Slice 15 acceptance value.
pub const RICH_IEBT: [i16; 20] = [
    67, 95, 172, 163, 168, 201, 189, 242, 196, 221, 192, 186, 168, 139, 102, 57, 35, 9, -55, -235,
];

/// An in-process daemon plus the tempdir it lives in.
pub struct TestDaemon {
    /// The running daemon.
    pub handle: Daemon,
    /// The injected recording backend.
    pub stub: Arc<StubBackend>,
    /// Holds `parameters.toml`, `defaults.toml`, `index.html`, and the
    /// config dir — dropped last.
    pub dir: TempDir,
}

impl TestDaemon {
    /// The daemon's bound address.
    pub fn addr(&self) -> SocketAddr {
        self.handle.addr()
    }

    /// The daemon's plugin socket address.
    pub fn socket_path(&self) -> std::path::PathBuf {
        socket_path_for(&self.dir)
    }
}

/// Writes a daemon dir fixture: the shipped `parameters.toml` +
/// `defaults.toml`, a placeholder UI file, and an empty config dir.
pub fn fixture_dir() -> TempDir {
    let dir = tempfile::tempdir().expect("create tempdir");
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    for shipped in ["parameters.toml", "defaults.toml"] {
        std::fs::copy(manifest.join(shipped), dir.path().join(shipped))
            .unwrap_or_else(|e| panic!("copy shipped {shipped}: {e}"));
    }
    std::fs::write(dir.path().join("index.html"), UI_HTML).expect("write ui fixture");
    dir
}

/// The config a [`fixture_dir`] daemon runs with: ephemeral port,
/// `config.toml` under `<dir>/data/`, plugin socket per
/// [`socket_path_for`].
pub fn config_for(dir: &TempDir) -> DaemonConfig {
    DaemonConfig {
        port: 0,
        ui_path: dir.path().join("index.html"),
        daemon_dir: dir.path().to_path_buf(),
        config_dir: dir.path().join("data"),
        socket_path: socket_path_for(dir),
    }
}

/// The fixture's plugin socket address — deterministic per tempdir, so
/// a daemon restarted over the same dir rebinds the same address. On
/// Windows the tempdir's unique name keys the pipe (pipes share one
/// global namespace; parallel tests must not collide).
pub fn socket_path_for(dir: &TempDir) -> std::path::PathBuf {
    let unique = dir
        .path()
        .file_name()
        .expect("tempdir has a name")
        .to_string_lossy();
    if cfg!(windows) {
        format!(r"\\.\pipe\dolbyx-test-{unique}").into()
    } else {
        dir.path().join("dolbyx.sock")
    }
}

/// Starts a daemon over an existing fixture dir with an injected
/// engine — the seam for non-stub backends (the qemu e2e suite,
/// failure fakes).
pub async fn start_with(dir: &TempDir, engine: Arc<dyn ddp_engine::Engine>) -> Daemon {
    Daemon::start(config_for(dir), engine)
        .await
        .expect("daemon starts")
}

/// Starts a stub-backed daemon over an existing fixture dir — the
/// restart primitive.
pub async fn start_over(dir: &TempDir) -> (Daemon, Arc<StubBackend>) {
    let stub = Arc::new(StubBackend::new());
    let daemon = start_with(dir, stub.clone()).await;
    (daemon, stub)
}

/// Starts an in-process daemon over a fresh fixture dir, engine stubbed.
pub async fn start_daemon() -> TestDaemon {
    let dir = fixture_dir();
    let (handle, stub) = start_over(&dir).await;
    TestDaemon { handle, stub, dir }
}

/// The `params` object a [`ddp_engine::VisFrame`] must appear as on
/// the wire (ADR-0005): the four arrays verbatim under their 4-CC keys.
pub fn vis_params_json(frame: &ddp_engine::VisFrame) -> serde_json::Value {
    serde_json::json!({
        "vnbg": frame.vnbg.to_vec(),
        "vnbe": frame.vnbe.to_vec(),
        "vcbg": frame.vcbg.to_vec(),
        "vcbe": frame.vcbe.to_vec(),
    })
}

/// The `set_params` batches an injected stub recorded, in issue order.
pub fn set_params_batches(stub: &StubBackend) -> Vec<Vec<(String, Vec<i16>)>> {
    stub.calls()
        .into_iter()
        .filter_map(|call| match call {
            ddp_engine::Call::SetParams(_, batch) => Some(batch),
            _ => None,
        })
        .collect()
}

/// Polls `condition` (up to 5 s) until it holds — the assertion
/// primitive for effects the daemon lands asynchronously (e.g. session
/// teardown after a disconnect it notices on its own).
pub async fn wait_until(condition: impl Fn() -> bool, what: &str) {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while !condition() {
        assert!(tokio::time::Instant::now() < deadline, "timed out: {what}");
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

/// Polls `config.toml` (up to 3 s) until it holds `expected` — the
/// throttled write-back assertion primitive.
pub async fn assert_config_becomes(path: &Path, expected: &str) {
    assert_config_becomes_within(path, expected, 3000).await;
}

/// [`assert_config_becomes`] with the deadline in the caller's hands —
/// tight bounds prove cadence (a leading-edge write lands well inside
/// the 100 ms window).
pub async fn assert_config_becomes_within(path: &Path, expected: &str, ms: u64) {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(ms);
    loop {
        let content = std::fs::read_to_string(path).expect("config.toml readable");
        if content == expected {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "config.toml settled at {content:?}, wanted {expected:?} within {ms} ms"
        );
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
}

/// The snapshot's profile with id `id`.
pub fn snapshot_profile<'a>(snapshot: &'a serde_json::Value, id: &str) -> &'a serde_json::Value {
    snapshot["snapshot"]["profiles"]
        .as_array()
        .expect("profiles array")
        .iter()
        .find(|profile| profile["id"] == id)
        .unwrap_or_else(|| panic!("profile `{id}` in snapshot"))
}

/// One raw `GET` over a real TCP connection; returns (status, body).
pub async fn http_get(addr: SocketAddr, path: &str) -> (u16, String) {
    let mut stream = tokio::net::TcpStream::connect(addr).await.expect("connect");
    let request = format!("GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .expect("send request");
    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .await
        .expect("read response");
    let response = String::from_utf8(response).expect("utf-8 response");
    let (head, body) = response.split_once("\r\n\r\n").expect("header/body split");
    let status: u16 = head
        .split_whitespace()
        .nth(1)
        .expect("status code")
        .parse()
        .expect("numeric status");
    (status, body.to_string())
}

/// A connected real-protocol WS client.
pub type WsClient =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Opens a real WebSocket to the daemon's `/ws`.
pub async fn ws_connect(addr: SocketAddr) -> WsClient {
    let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws"))
        .await
        .expect("ws connect");
    ws
}

/// Opens `/ws` and consumes the snapshot-on-connect `state` event.
pub async fn connected(addr: SocketAddr) -> WsClient {
    let mut ws = ws_connect(addr).await;
    assert_eq!(recv_json(&mut ws).await["type"], "state");
    ws
}

/// Issues `set_power` and awaits its `ack` promise-style (ADR-0005:
/// replies aren't positionally paired) — pub/sub `state` and `vis`
/// events, e.g. a plugin connection's main-session broadcast or its
/// blocks' frames, may interleave.
pub async fn set_power(ws: &mut WsClient, on: bool) {
    let request_id = format!("rq-set-power-{on}");
    send_json(
        ws,
        &serde_json::json!({ "cmd": "set_power", "request_id": request_id, "on": on }),
    )
    .await;
    loop {
        let frame = recv_json(ws).await;
        if frame["type"] == "state" || frame["type"] == "vis" {
            continue;
        }
        assert_eq!(frame["type"], "ack", "set_power must ack, got {frame}");
        assert_eq!(frame["request_id"], request_id.as_str());
        return;
    }
}

/// Issues an `edit_profile` patching one param and awaits its `ack`
/// promise-style, as [`set_power`].
pub async fn edit_param(ws: &mut WsClient, id: &str, param: &str, values: &[i16]) {
    let request_id = format!("rq-edit-{id}-{param}");
    send_json(
        ws,
        &serde_json::json!({
            "cmd": "edit_profile", "request_id": request_id,
            "id": id, "params": { param: values },
        }),
    )
    .await;
    loop {
        let frame = recv_json(ws).await;
        if frame["type"] == "state" || frame["type"] == "vis" {
            continue;
        }
        assert_eq!(frame["type"], "ack", "edit_profile must ack, got {frame}");
        assert_eq!(frame["request_id"], request_id.as_str());
        return;
    }
}

/// Receives frames until the next `state` event — for asserting a
/// snapshot on a stream where pub/sub `vis` events interleave.
pub async fn recv_state(ws: &mut WsClient) -> serde_json::Value {
    loop {
        let frame = recv_json(ws).await;
        if frame["type"] == "state" {
            return frame;
        }
    }
}

/// Sends one JSON text frame.
pub async fn send_json(ws: &mut WsClient, value: &serde_json::Value) {
    send_text(ws, &value.to_string()).await;
}

/// Sends one raw text frame — for deliberately malformed payloads.
pub async fn send_text(ws: &mut WsClient, text: &str) {
    use futures_util::SinkExt;
    ws.send(tokio_tungstenite::tungstenite::Message::text(text))
        .await
        .expect("ws send");
}

/// Receives the next JSON text frame (skipping control frames).
/// Bounded at 5 s so a silent daemon fails the test instead of hanging.
pub async fn recv_json(ws: &mut WsClient) -> serde_json::Value {
    use futures_util::StreamExt;
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let message = ws.next().await.expect("ws open").expect("ws frame");
            if let tokio_tungstenite::tungstenite::Message::Text(text) = message {
                return serde_json::from_str(&text).expect("frame is valid JSON");
            }
        }
    })
    .await
    .expect("no frame within 5s")
}

/// Waits up to `ms` for a JSON text frame; `None` on timeout — the
/// assertion primitive for "this client must NOT receive a frame".
pub async fn try_recv_json(ws: &mut WsClient, ms: u64) -> Option<serde_json::Value> {
    tokio::time::timeout(std::time::Duration::from_millis(ms), recv_json(ws))
        .await
        .ok()
}

/// Extracts and parses the injected `window.__BOOTSTRAP__` JSON.
pub fn bootstrap_json(html: &str) -> serde_json::Value {
    let start = html
        .find("window.__BOOTSTRAP__ = ")
        .expect("bootstrap global present")
        + "window.__BOOTSTRAP__ = ".len();
    let end = html[start..].find(";</script>").expect("script tail") + start;
    serde_json::from_str(&html[start..end]).expect("bootstrap is valid JSON")
}
