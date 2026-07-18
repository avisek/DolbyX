//! `WsServer` — one WebSocket per UI tab: snapshot on connect, typed
//! command dispatch (with the `set_power` behavior), broadcast fan-out
//! (`state` + the bridged `vis` feed).

use std::sync::Arc;

use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use ddp_state::Command;
use tokio::sync::broadcast;

use crate::App;
use crate::ws_commands::{WsCommand, WsEvent, ack, engine_rejected, invalid_request};

/// Bridges the supervisor's vis fan-out onto the update channel: each
/// frame serialized once and queued for every connection — `vis` has
/// no originator rule, and a freshly minted [`ConnId`] matches nobody.
/// Runs until aborted at shutdown (the app keeps the supervisor — and
/// so the channel — alive).
pub(crate) async fn vis_bridge(app: Arc<App>) {
    // One minted identity for the whole feed — the allocator never
    // reissues it, so it matches no connection, ever.
    let origin = app.fresh_conn_id();
    let mut frames = app.supervisor.subscribe_vis();
    loop {
        let frame = match frames.recv().await {
            Ok(frame) => frame,
            // Dropped frames need no resync — the stream is pure.
            Err(broadcast::error::RecvError::Lagged(_)) => continue,
            Err(broadcast::error::RecvError::Closed) => return,
        };
        let event = WsEvent::Vis {
            params: (&frame).into(),
        }
        .to_text();
        let _ = app.updates.send((origin, event.into()));
    }
}

/// Internal identity of one connection — never on the wire; exists
/// solely so the daemon can exclude the originator from `state`
/// fan-outs (ADR-0005). Non-WS mutations broadcast under a freshly
/// minted id, which matches no connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ConnId(pub(crate) u64);

/// `GET /ws`: upgrade and serve the connection.
pub(crate) async fn handle_upgrade(ws: WebSocketUpgrade, State(app): State<Arc<App>>) -> Response {
    ws.on_upgrade(move |socket| connection(socket, app))
}

/// One client connection: full snapshot first, then command dispatch
/// interleaved with broadcast delivery.
async fn connection(mut socket: WebSocket, app: Arc<App>) {
    let conn_id = app.fresh_conn_id();
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
            mutate(app, conn_id, &request_id, Command::SetPower { on }).await
        }
        WsCommand::SetProfile { request_id, id } => {
            mutate(app, conn_id, &request_id, Command::SetProfile { id }).await
        }
        WsCommand::EditProfile {
            request_id,
            id,
            params,
        } => {
            mutate(
                app,
                conn_id,
                &request_id,
                Command::EditProfile { id, params },
            )
            .await
        }
        WsCommand::ResetProfile { request_id, id } => {
            mutate(app, conn_id, &request_id, Command::ResetProfile { id }).await
        }
        WsCommand::SetEqPreset {
            request_id,
            profile_id,
            id,
        } => {
            mutate(
                app,
                conn_id,
                &request_id,
                Command::SetEqPreset { profile_id, id },
            )
            .await
        }
        WsCommand::EditEqPreset {
            request_id,
            id,
            params,
        } => {
            mutate(
                app,
                conn_id,
                &request_id,
                Command::EditEqPreset { id, params },
            )
            .await
        }
        WsCommand::ResetEqPreset { request_id, id } => {
            mutate(app, conn_id, &request_id, Command::ResetEqPreset { id }).await
        }
    }
}

/// Applies one mutation command: validate → engine → persist →
/// broadcast → reply. State stays authoritative even when the engine
/// is down — the flip persists and broadcasts, and the supervisor
/// replays it onto the engine once it recovers.
async fn mutate(app: &App, conn_id: ConnId, request_id: &str, command: Command) -> Vec<String> {
    let mut state = app.state.write().await;
    let diff = match state.apply(command, &app.params) {
        Ok(diff) => diff,
        // Validation leaves state untouched — nothing to fan out.
        Err(error) => return vec![invalid_request(Some(request_id), error.to_string()).to_text()],
    };
    if diff.is_empty() {
        return vec![ack(request_id).to_text()];
    }
    let mut engine_failure = None;
    if let Some(power) = diff.power
        && let Err(error) = app.supervisor.set_power(power)
    {
        tracing::error!(%error, "engine set_power failed");
        engine_failure = Some(error);
    }
    if let Some(batch) = diff.params {
        // The engine hears the diff (full set on switch/reset, edited
        // entries on a live edit); the replay set for future session
        // inits and crash recovery is the full resolved profile.
        let resolved = state.resolved_batch(&app.params);
        if let Err(error) = app.supervisor.apply_params(&batch, resolved) {
            tracing::error!(%error, "engine set_params failed");
            engine_failure = Some(error);
        }
    }
    app.persistence.flush(&state);
    // Serialize + queue under the write lock so broadcast order always
    // matches state order.
    let event = WsEvent::State {
        snapshot: app.snapshot_json_of(&state),
    }
    .to_text();
    let _ = app.updates.send((conn_id, event.into()));
    drop(state);
    vec![match engine_failure {
        None => ack(request_id).to_text(),
        Some(error) => engine_rejected(request_id, &error).to_text(),
    }]
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
