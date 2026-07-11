//! `WsCommands` — the serde-typed wire vocabulary (ADR-0005). Every
//! command carries a client-generated `request_id`, echoed on exactly
//! one `ack`/`error`; `state` events are pub/sub.

use serde::{Deserialize, Serialize};

/// A client → daemon command frame. Unknown `cmd` values and shape
/// mismatches fail serde and surface as `INVALID_REQUEST`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum WsCommand {
    /// Ask for a fresh full snapshot.
    GetState {
        /// Correlation id echoed on the reply.
        request_id: String,
    },
    /// Master power toggle.
    SetPower {
        /// Correlation id echoed on the reply.
        request_id: String,
        /// The requested power state.
        on: bool,
    },
}

/// A daemon → client event frame.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum WsEvent<'a> {
    /// Full state snapshot — on connect, on `get_state`, and broadcast
    /// after any mutation.
    State {
        /// The snapshot JSON.
        snapshot: serde_json::Value,
    },
    /// The one success reply per command.
    Ack {
        /// The echoed correlation id.
        request_id: &'a str,
        /// Always `true` — failures use [`WsEvent::Error`].
        ok: bool,
    },
    /// The one failure reply per command; `request_id` is `null` when
    /// the frame was too malformed to carry one.
    Error {
        /// The echoed correlation id, when recoverable.
        request_id: Option<&'a str>,
        /// Machine-readable failure class.
        code: ErrorCode,
        /// Human-readable cause.
        message: String,
    },
}

/// Machine-readable failure classes on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum ErrorCode {
    /// The daemon rejected the frame up front: malformed JSON, unknown
    /// cmd, failed validation. The only daemon-side code.
    InvalidRequest,
}

impl WsEvent<'_> {
    /// The frame as wire text.
    pub(crate) fn to_text(&self) -> String {
        serde_json::to_string(self).expect("events always serialize")
    }
}

/// Builds the standard success reply.
pub(crate) fn ack(request_id: &str) -> WsEvent<'_> {
    WsEvent::Ack {
        request_id,
        ok: true,
    }
}

/// Builds an `INVALID_REQUEST` error reply.
pub(crate) fn invalid_request(request_id: Option<&str>, message: String) -> WsEvent<'_> {
    WsEvent::Error {
        request_id,
        code: ErrorCode::InvalidRequest,
        message,
    }
}
