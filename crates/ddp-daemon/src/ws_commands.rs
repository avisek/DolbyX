//! `WsCommands` — the serde-typed wire vocabulary (ADR-0005). Every
//! command carries a client-generated `request_id`, echoed on exactly
//! one `ack`/`error`; `state` events are pub/sub.

use serde::{Deserialize, Serialize};

use crate::engine_supervisor::SupervisorError;

/// A client → daemon command frame. Unknown `cmd` values and shape
/// mismatches fail serde and surface as `INVALID_REQUEST` (i16 bounds
/// included — an out-of-i16 value never reaches validation).
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
    /// Select the active profile.
    SetProfile {
        /// Correlation id echoed on the reply.
        request_id: String,
        /// The profile to select.
        id: ddp_state::ProfileId,
    },
    /// Write a param map into one profile.
    EditProfile {
        /// Correlation id echoed on the reply.
        request_id: String,
        /// The profile to edit.
        id: ddp_state::ProfileId,
        /// The edited entries: `{ "<4-CC>": [i16, …] }`.
        params: std::collections::HashMap<String, Vec<i16>>,
    },
    /// Drop a profile's own overrides, restoring its baseline.
    ResetProfile {
        /// Correlation id echoed on the reply.
        request_id: String,
        /// The profile to reset.
        id: ddp_state::ProfileId,
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
        /// The engine's reply status when the failure carries one
        /// (e.g. `-22`); omitted otherwise.
        #[serde(skip_serializing_if = "Option::is_none")]
        status: Option<i32>,
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
    /// The engine refused or lost the operation after daemon-side
    /// validation passed (ADR-0005).
    EngineRejected,
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
        status: None,
        message,
    }
}

/// Builds an `ENGINE_REJECTED` error reply from a supervisor failure.
pub(crate) fn engine_rejected<'a>(request_id: &'a str, error: &SupervisorError) -> WsEvent<'a> {
    WsEvent::Error {
        request_id: Some(request_id),
        code: ErrorCode::EngineRejected,
        status: error.engine_status(),
        message: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ddp_engine::EngineError;

    /// The wire shape of ADR-0005's `error` event: `status` present
    /// exactly when the engine replied one.
    #[test]
    fn engine_rejected_serializes_with_an_optional_status() {
        let rejected = SupervisorError::Engine(EngineError::Rejected { status: -22 });
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&engine_rejected("r1", &rejected).to_text())
                .unwrap(),
            serde_json::json!({
                "type": "error",
                "request_id": "r1",
                "code": "ENGINE_REJECTED",
                "status": -22,
                "message": "engine rejected the operation (status -22)",
            }),
        );
        let crashed = SupervisorError::EngineCrashed("engine gone".into());
        let event =
            serde_json::from_str::<serde_json::Value>(&engine_rejected("r2", &crashed).to_text())
                .unwrap();
        assert!(event.get("status").is_none(), "no status on a crash");
    }
}
