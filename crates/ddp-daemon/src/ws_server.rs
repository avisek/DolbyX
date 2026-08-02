//! `WsServer` — one WebSocket per UI tab: snapshot on connect, typed
//! command dispatch (with the `set_power` behavior), broadcast fan-out
//! (`state` + the bridged `vis` feed).

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::response::Response;
use ddp_state::Command;
use tokio::sync::broadcast;

use crate::App;
use crate::ws_commands::{
    WsCommand, WsEvent, ack, engine_rejected, invalid_request, lan_bind_failed,
};

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

/// `GET /ws`: upgrade and serve the connection. The peer address
/// decides severability — loopback connections outlive every LAN
/// access flip; non-loopback ones live at the gate's pleasure
/// (issue #75, ADR-0012).
pub(crate) async fn handle_upgrade(
    ws: WebSocketUpgrade,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    State(app): State<Arc<App>>,
) -> Response {
    ws.on_upgrade(move |socket| connection(socket, peer, app))
}

/// One client connection: full snapshot first, then command dispatch
/// interleaved with broadcast delivery — under the LAN gate for
/// non-loopback peers.
async fn connection(mut socket: WebSocket, peer: SocketAddr, app: Arc<App>) {
    let conn_id = app.fresh_conn_id();
    let mut updates = app.updates.subscribe();
    let mut lan_gate = app.lan_gate.subscribe();
    let severable = !peer.ip().is_loopback();
    if send(&mut socket, &state_event(&app, None).await)
        .await
        .is_err()
    {
        return;
    }
    loop {
        tokio::select! {
            // The gate is checked first (`biased`) and level-triggered:
            // a non-loopback task severs on its next iteration once the
            // gate reads off — never processing another frame, and only
            // after whatever reply it was sending flushed, so the
            // originator's own ack outruns its close (the reply law,
            // even when the reply severs the replier). Returning drops
            // the socket; a task busy in a branch below severs one
            // iteration later, since `wait_for` re-checks the value.
            // Even a send wedged on a stalled peer only defers the
            // close, never grants control: the wedged task dispatches
            // nothing, and the send's resolution runs into the gate.
            biased;
            // (The async block drops `wait_for`'s non-Send lock guard
            // before the select resumes.)
            () = async { let _ = lan_gate.wait_for(|on| !on).await; }, if severable => {
                return;
            }
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
                        state_event(&app, None).await.into()
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
#[expect(
    clippy::too_many_lines,
    reason = "a flat match, one arm per wire command — length tracks the vocabulary"
)]
async fn dispatch(app: &Arc<App>, conn_id: ConnId, text: &str) -> Vec<String> {
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
        // The `state` event itself is the reply, echoing the id — the
        // total reply law (ADR-0005): one reply per command, no ack.
        WsCommand::GetState { request_id } => {
            vec![state_event(app, Some(&request_id)).await]
        }
        WsCommand::SetPower { request_id, on } => {
            mutate(app, conn_id, &request_id, Command::SetPower { on }).await
        }
        WsCommand::SetLanAccess { request_id, on } => {
            set_lan_access(app, conn_id, &request_id, on).await
        }
        WsCommand::SetProfile { request_id, id } => {
            mutate(app, conn_id, &request_id, Command::SetProfile { id }).await
        }
        WsCommand::EditProfile {
            request_id,
            id,
            name,
            params,
            selected_eq_preset,
        } => {
            mutate(
                app,
                conn_id,
                &request_id,
                Command::EditProfile {
                    id,
                    name,
                    params,
                    selected_eq_preset,
                },
            )
            .await
        }
        WsCommand::AddProfile {
            request_id,
            name,
            params,
            selected_eq_preset,
        } => {
            mutate(
                app,
                conn_id,
                &request_id,
                Command::AddProfile {
                    name,
                    params,
                    selected_eq_preset,
                },
            )
            .await
        }
        WsCommand::AddEqPreset {
            request_id,
            name,
            params,
        } => {
            mutate(
                app,
                conn_id,
                &request_id,
                Command::AddEqPreset { name, params },
            )
            .await
        }
        WsCommand::ResetProfile {
            request_id,
            id,
            only,
        } => {
            mutate(
                app,
                conn_id,
                &request_id,
                Command::ResetProfile { id, only },
            )
            .await
        }
        WsCommand::EditEqPreset {
            request_id,
            id,
            name,
            params,
        } => {
            mutate(
                app,
                conn_id,
                &request_id,
                Command::EditEqPreset { id, name, params },
            )
            .await
        }
        WsCommand::ResetEqPreset {
            request_id,
            id,
            only,
        } => {
            mutate(
                app,
                conn_id,
                &request_id,
                Command::ResetEqPreset { id, only },
            )
            .await
        }
        WsCommand::RemoveProfile { request_id, id } => {
            mutate(app, conn_id, &request_id, Command::RemoveProfile { id }).await
        }
        WsCommand::RemoveEqPreset { request_id, id } => {
            mutate(app, conn_id, &request_id, Command::RemoveEqPreset { id }).await
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
        return vec![ack(request_id, None).to_text()];
    }
    // The engine hears the diff (full set on switch/reset, edited
    // entries on a live edit); the replay set for future session inits
    // and crash recovery is the full resolved profile.
    let params = diff
        .params
        .map(|batch| (batch, state.resolved_batch(&app.params)));
    let engine_failure = app.push_to_engine(diff.power, params);
    app.persistence.flush(&state);
    app.queue_state_broadcast(&state, conn_id);
    drop(state);
    vec![match engine_failure {
        None => ack(request_id, diff.minted.as_deref()).to_text(),
        Some(error) => engine_rejected(request_id, &error).to_text(),
    }]
}

/// Applies one `set_lan_access` (issue #70, ADR-0012): rebind first,
/// store second. A redundant set acks without touching the listener; a
/// failed rebind replies `LAN_BIND_FAILED` with the previous address
/// re-bound and the store exactly where it was — no flush, no
/// broadcast. On success the scalar moves, persists per the write law,
/// and broadcasts to every other connection (the originator's ack is
/// its only feedback).
///
/// # Panics
///
/// Never in practice: `SetLanAccess` has nothing to validate.
async fn set_lan_access(
    app: &Arc<App>,
    conn_id: ConnId,
    request_id: &str,
    on: bool,
) -> Vec<String> {
    let mut state = app.state.write().await;
    if state.lan_access == on {
        return vec![ack(request_id, None).to_text()];
    }
    if let Err(error) = crate::http_server::rebind(app, on).await {
        return vec![lan_bind_failed(request_id, &error).to_text()];
    }
    let _ = state
        .apply(Command::SetLanAccess { on }, &app.params)
        .expect("set_lan_access never fails validation");
    app.persistence.flush(&state);
    app.queue_state_broadcast(&state, conn_id);
    drop(state);
    vec![ack(request_id, None).to_text()]
}

/// The full-snapshot `state` event as wire text — `request_id` only
/// when the snapshot answers a `get_state` (broadcasts are id-less).
async fn state_event(app: &App, request_id: Option<&str>) -> String {
    WsEvent::State {
        snapshot: app.snapshot_json().await,
        request_id,
    }
    .to_text()
}

/// Sends one text frame.
async fn send(socket: &mut WebSocket, text: &str) -> Result<(), axum::Error> {
    socket.send(Message::Text(text.to_string().into())).await
}
