//! `HttpServer` — exactly two routes: `GET /` (bootstrap-injected HTML)
//! and `GET /ws` (upgrade; lands with the WS behaviors). No `/api/*`
//! routes exist (ADR-0006).

use std::sync::Arc;

use axum::Router;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;

use crate::App;

/// The placeholder the UI HTML carries; replaced per request.
const BOOTSTRAP_MARKER: &str = "<!--BOOTSTRAP-->";

/// Builds the daemon router — `GET /` and `GET /ws`, nothing else.
pub(crate) fn router(app: Arc<App>) -> Router {
    Router::new()
        .route("/", get(serve_index))
        .route("/ws", get(crate::ws_server::handle_upgrade))
        .with_state(app)
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
