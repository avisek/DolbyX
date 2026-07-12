//! `WsServer` — one WebSocket per UI tab: snapshot on connect, typed
//! command dispatch (with the `set_power` behavior), broadcast fan-out.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use ddp_state::Command;
use tokio::sync::broadcast;

use crate::App;
use crate::ws_commands::{WsCommand, WsEvent, ack, engine_rejected, invalid_request};

/// Internal identity of one WS connection — never on the wire; exists
/// solely so the daemon can exclude the originator from `state`
/// fan-outs (ADR-0005).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ConnId(u64);

/// `GET /ws`: upgrade and serve the connection.
pub(crate) async fn handle_upgrade(ws: WebSocketUpgrade, State(app): State<Arc<App>>) -> Response {
    ws.on_upgrade(move |socket| connection(socket, app))
}

/// One client connection: full snapshot first, then command dispatch
/// interleaved with broadcast delivery.
async fn connection(mut socket: WebSocket, app: Arc<App>) {
    let conn_id = ConnId(app.next_conn_id.fetch_add(1, Ordering::Relaxed));
    let mut updates = app.updates.subscribe();
    if send(&mut socket, &state_event(&app).await).await.is_err() {
        return;
    }
    loop {
        tokio::select! {
            message = socket.recv() => {
                let Some(Ok(message)) = message else { return };
                let Message::Text(text) = message else {
                    continue; // control frames; tungstenite answers pings itself
                };
                for reply in dispatch(&app, conn_id, &text).await {
                    if send(&mut socket, &reply).await.is_err() {
                        return;
                    }
                }
            }
            update = updates.recv() => {
                let text = match update {
                    Ok((origin, _)) if origin == conn_id => continue,
                    Ok((_, text)) => text,
                    // Lagged: resync with a fresh snapshot.
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        state_event(&app).await.into()
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                };
                if send(&mut socket, &text).await.is_err() {
                    return;
                }
            }
        }
    }
}

/// Handles one command frame; returns the reply frames for the
/// originator, in order. Mutations broadcast the resulting `state` to
/// every *other* connection before the originator's ack is queued.
async fn dispatch(app: &App, conn_id: ConnId, text: &str) -> Vec<String> {
    let command = match serde_json::from_str::<WsCommand>(text) {
        Ok(command) => command,
        Err(error) => {
            // Best-effort id recovery: a structured-but-invalid frame
            // (unknown cmd, shape mismatch) still settles promise-style.
            let frame: Option<serde_json::Value> = serde_json::from_str(text).ok();
            let request_id = frame
                .as_ref()
                .and_then(|frame| frame.get("request_id"))
                .and_then(serde_json::Value::as_str);
            return vec![invalid_request(request_id, error.to_string()).to_text()];
        }
    };
    match command {
        WsCommand::GetState { request_id } => {
            vec![state_event(app).await, ack(&request_id).to_text()]
        }
        WsCommand::SetPower { request_id, on } => {
            let mut state = app.state.write().await;
            let diff = state
                .apply(Command::SetPower { on })
                .unwrap_or_else(|error| match error {});
            let mut engine_failure = None;
            if let Some(power) = diff.power {
                if let Err(error) = app.supervisor.set_power(power) {
                    tracing::error!(%error, "engine set_power failed");
                    engine_failure = Some(error);
                }
                // State stays authoritative even when the engine is
                // down — persist and broadcast the flip; the supervisor
                // replays it onto the engine once it recovers.
                app.persistence.flush(&state);
                // Serialize + queue under the write lock so broadcast
                // order always matches state order.
                let event = WsEvent::State {
                    snapshot: app.snapshot_json_of(&state),
                }
                .to_text();
                let _ = app.updates.send((conn_id, event.into()));
            }
            drop(state);
            vec![match engine_failure {
                None => ack(&request_id).to_text(),
                Some(error) => engine_rejected(&request_id, &error).to_text(),
            }]
        }
    }
}

/// The full-snapshot `state` event as wire text.
async fn state_event(app: &App) -> String {
    WsEvent::State {
        snapshot: app.snapshot_json().await,
    }
    .to_text()
}

/// Sends one text frame.
async fn send(socket: &mut WebSocket, text: &str) -> Result<(), axum::Error> {
    socket.send(Message::Text(text.to_string().into())).await
}
