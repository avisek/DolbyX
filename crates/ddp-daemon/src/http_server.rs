//! `HttpServer` — exactly two routes: `GET /` (bootstrap-injected HTML)
//! and `GET /ws` (upgrade; lands with the WS behaviors). No `/api/*`
//! routes exist (ADR-0006). Same-origin hardening (issue #69,
//! ADR-0012) fronts them, independent of the LAN access toggle; the
//! toggle itself (issue #70) is the listener — loopback while off, the
//! LAN interface while on, rebound live — plus a per-request door gate
//! for connections established before an off-flip.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;

use axum::Router;
use axum::extract::connect_info::Connected;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::serve::IncomingStream;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

use crate::App;

/// The placeholder the UI HTML carries; replaced per request.
const BOOTSTRAP_MARKER: &str = "<!--BOOTSTRAP-->";

/// Builds the daemon router — `GET /` and `GET /ws`, nothing else,
/// fronted by the LAN door gate and the same-origin hardening
/// (ADR-0012).
pub(crate) fn router(app: Arc<App>) -> Router {
    Router::new()
        .route("/", get(serve_index))
        .route(
            "/ws",
            get(crate::ws_server::handle_upgrade).layer(middleware::from_fn(reject_cross_origin)),
        )
        .layer(middleware::from_fn(reject_dns_names))
        .layer(middleware::from_fn_with_state(
            app.clone(),
            reject_lan_door_when_off,
        ))
        .with_state(app)
}

/// The daemon-side address a connection was accepted on — which door
/// it came through. The *local* address, not the peer: the doors are
/// defined by where the daemon listens (ADR-0012's bind-address gate),
/// and a connection to the LAN interface is a LAN-door connection even
/// from this machine.
#[derive(Debug, Clone, Copy)]
pub(crate) struct LocalAddr(Option<SocketAddr>);

impl LocalAddr {
    /// Whether the connection came through the LAN door — any accept
    /// address other than `127.0.0.1` (production's `0.0.0.0` accepts
    /// both doors on one listener; the tests' second-loopback LAN
    /// door is why this compares against the loopback bind address,
    /// not `is_loopback`). An unreadable socket counts as LAN: refuse
    /// rather than trust what can't be verified.
    pub(crate) fn lan_door(self) -> bool {
        self.0
            .is_none_or(|addr| addr.ip() != IpAddr::V4(Ipv4Addr::LOCALHOST))
    }
}

impl Connected<IncomingStream<'_, TcpListener>> for LocalAddr {
    fn connect_info(stream: IncomingStream<'_, TcpListener>) -> Self {
        Self(stream.io().local_addr().ok())
    }
}

/// Refuses LAN-door requests while LAN access is off (ADR-0012). The
/// rebind already closed that door for *new* connections; this closes
/// it for requests still arriving on ones established before the
/// off-flip — a browser's kept-alive socket outlives the toggle, and a
/// trust toggle that doesn't revoke is broken.
async fn reject_lan_door_when_off(
    State(app): State<Arc<App>>,
    ConnectInfo(local): ConnectInfo<LocalAddr>,
    request: Request,
    next: Next,
) -> Response {
    if local.lan_door() && !*app.lan_access.borrow() {
        tracing::warn!(?local, "refused: LAN access is off");
        return StatusCode::FORBIDDEN.into_response();
    }
    next.run(request).await
}

/// Serves `router` on `listener` until aborted. Established connections
/// ride their own tasks — aborting stops accepting only; revocation is
/// the door gate's and the WS severing's job.
pub(crate) fn spawn_serve(listener: TcpListener, router: Router) -> JoinHandle<()> {
    tokio::spawn(async move {
        let service = router.into_make_service_with_connect_info::<LocalAddr>();
        if let Err(error) = axum::serve(listener, service).await {
            tracing::error!(%error, "http server exited");
        }
    })
}

/// The serve-task slot shared by the rebind loop and shutdown. `None`
/// between an abort and the next successful bind — a `JoinHandle`
/// panics if polled again after completion, so whoever drains it
/// takes it out.
pub(crate) type ServeSlot = Arc<tokio::sync::Mutex<Option<JoinHandle<()>>>>;

/// Aborts and awaits the slot's serve task, dropping its listener —
/// awaited, not just aborted: the port must actually be free before
/// it can bind again.
pub(crate) async fn drain_serve(slot: &mut Option<JoinHandle<()>>) {
    if let Some(mut task) = slot.take() {
        task.abort();
        let _ = (&mut task).await;
    }
}

/// Follows the LAN access toggle (issue #70): on each flip, drop the
/// current listener and open the new door — loopback while off,
/// `lan_ip` while on — on the same port, live, no daemon restart. A
/// failed bind (the freed port was snatched inside the swap window)
/// logs the address it actually tried and retries every second until
/// it lands or the toggle moves again.
pub(crate) async fn rebind_loop(
    app: Arc<App>,
    router: Router,
    lan_ip: IpAddr,
    port: u16,
    serving: ServeSlot,
) {
    let mut lan = app.lan_access.subscribe();
    loop {
        if lan.changed().await.is_err() {
            return;
        }
        // Holding the slot across the retries keeps shutdown ordered:
        // it aborts this loop first, which releases the lock.
        let mut current = serving.lock().await;
        drain_serve(&mut current).await;
        loop {
            let on = *lan.borrow_and_update();
            let door = if on {
                lan_ip
            } else {
                IpAddr::V4(Ipv4Addr::LOCALHOST)
            };
            let target = SocketAddr::new(door, port);
            match TcpListener::bind(target).await {
                Ok(listener) => {
                    *current = Some(spawn_serve(listener, router.clone()));
                    tracing::info!(addr = %target, lan_access = on, "listener rebound");
                    break;
                }
                Err(error) => {
                    tracing::error!(addr = %target, %error, "rebind failed; retrying");
                    tokio::select! {
                        () = tokio::time::sleep(std::time::Duration::from_secs(1)) => {}
                        _ = lan.changed() => {}
                    }
                }
            }
        }
    }
}

/// Refuses any request whose `Host` host is neither an IP literal nor
/// `localhost` (ADR-0012). Legit clients only ever address the daemon
/// that way (no mDNS — epic #67), so a resolving DNS name means an
/// attacker-controlled record pointed the browser here: DNS rebinding,
/// which the cross-origin check can't see (a rebound page's `Origin`
/// agrees with its `Host`).
async fn reject_dns_names(request: Request, next: Next) -> Response {
    match request_host(request.headers()) {
        Some(host) if is_ip_or_localhost(host) => next.run(request).await,
        host => {
            tracing::warn!(
                ?host,
                "refused: Host is neither an IP literal nor localhost"
            );
            StatusCode::FORBIDDEN.into_response()
        }
    }
}

/// Refuses a WS upgrade whose `Origin` host differs from the `Host`
/// host (ADR-0012): WS is CORS-exempt, so any webpage that can route to
/// the daemon could otherwise open it and command everything. Only
/// browsers send `Origin` — no-`Origin` clients (tests, curl, scripts)
/// pass, as does the daemon-served UI (its page origin is the daemon).
/// Hosts compare textually, never resolved — resolving would reopen
/// exactly the rebinding hole.
async fn reject_cross_origin(request: Request, next: Next) -> Response {
    let headers = request.headers();
    let Some(origin) = headers.get(header::ORIGIN) else {
        return next.run(request).await;
    };
    let origin_host = origin.to_str().ok().and_then(origin_host);
    match (origin_host, request_host(headers)) {
        (Some(origin), Some(host)) if origin.eq_ignore_ascii_case(host) => next.run(request).await,
        (_, host) => {
            tracing::warn!(?origin, ?host, "ws upgrade refused: cross-origin");
            StatusCode::FORBIDDEN.into_response()
        }
    }
}

/// The request's `Host` host — port stripped; `None` when absent or
/// unreadable (refused: locality can't be verified). The raw header is
/// the truth — no reverse proxy sits in front, and `X-Forwarded-Host`
/// is script-settable.
fn request_host(headers: &axum::http::HeaderMap) -> Option<&str> {
    headers
        .get(header::HOST)
        .and_then(|host| host.to_str().ok())
        .map(host_part)
}

/// The host of an authority (`host[:port]`) — the port, when present,
/// stripped; a bracketed IPv6 literal's colons are not a port separator.
fn host_part(authority: &str) -> &str {
    match authority.rfind(':') {
        Some(index) if !authority[index..].contains(']') => &authority[..index],
        _ => authority,
    }
}

/// The host of an `Origin` value — `None` for an opaque origin
/// (`null`) or anything else that isn't `scheme://authority`.
fn origin_host(origin: &str) -> Option<&str> {
    let (_scheme, authority) = origin.split_once("://")?;
    Some(host_part(authority))
}

/// Whether a `Host` host can only name this machine directly — an IP
/// literal (IPv6 bracketed, as the header syntax requires) or
/// `localhost`. Anything else is a DNS name.
fn is_ip_or_localhost(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host.parse::<Ipv4Addr>().is_ok()
        || host
            .strip_prefix('[')
            .and_then(|host| host.strip_suffix(']'))
            .is_some_and(|host| host.parse::<Ipv6Addr>().is_ok())
}

/// `GET /`: the UI HTML from disk with `window.__BOOTSTRAP__` injected —
/// params + state, re-serialized on every request so a fresh tab always
/// paints current truth (ADR-0006).
async fn serve_index(State(app): State<Arc<App>>) -> Response {
    let html = match tokio::fs::read_to_string(&app.ui_path).await {
        Ok(html) => html,
        Err(error) => {
            tracing::error!(path = %app.ui_path.display(), %error, "ui html unreadable");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let bootstrap = serde_json::json!({
        "params": app.params_json,
        "state": app.snapshot_json().await,
    });
    // `<` is escaped so no JSON string can close the <script> element.
    let json = bootstrap.to_string().replace('<', "\\u003c");
    let script = format!("<script>window.__BOOTSTRAP__ = {json};</script>");
    Html(html.replacen(BOOTSTRAP_MARKER, &script, 1)).into_response()
}
