//! `HttpServer` — exactly two routes: `GET /` (bootstrap-injected HTML)
//! and `GET /ws` (upgrade; lands with the WS behaviors). No `/api/*`
//! routes exist (ADR-0006). Same-origin hardening (issue #69,
//! ADR-0012) fronts them, independent of the LAN access toggle.

use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::Arc;

use axum::Router;
use axum::extract::{Request, State};
use axum::http::{StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;

use crate::App;

/// The placeholder the UI HTML carries; replaced per request.
const BOOTSTRAP_MARKER: &str = "<!--BOOTSTRAP-->";

/// Builds the daemon router — `GET /` and `GET /ws`, nothing else,
/// fronted by the same-origin hardening (ADR-0012).
pub(crate) fn router(app: Arc<App>) -> Router {
    Router::new()
        .route("/", get(serve_index))
        .route(
            "/ws",
            get(crate::ws_server::handle_upgrade).layer(middleware::from_fn(reject_cross_origin)),
        )
        .layer(middleware::from_fn(reject_dns_names))
        .with_state(app)
}

/// Refuses any request whose `Host` host is neither an IP literal nor
/// `localhost` (ADR-0012). Legit clients only ever address the daemon
/// that way (no mDNS — epic #67), so a resolving DNS name means an
/// attacker-controlled record pointed the browser here: DNS rebinding,
/// which the cross-origin check can't see (a rebound page's `Origin`
/// agrees with its `Host`). The raw `Host` header is the truth — no
/// reverse proxy sits in front, and `X-Forwarded-Host` is
/// script-settable.
async fn reject_dns_names(request: Request, next: Next) -> Response {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|host| host.to_str().ok());
    match host.map(host_part) {
        Some(host) if is_ip_or_localhost(host) => next.run(request).await,
        _ => {
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
    let request_host = headers
        .get(header::HOST)
        .and_then(|host| host.to_str().ok())
        .map(host_part);
    match (origin_host, request_host) {
        (Some(origin), Some(host)) if origin.eq_ignore_ascii_case(host) => next.run(request).await,
        _ => {
            tracing::warn!(?origin, host = ?request_host, "ws upgrade refused: cross-origin");
            StatusCode::FORBIDDEN.into_response()
        }
    }
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
