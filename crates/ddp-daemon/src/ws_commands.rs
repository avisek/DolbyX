//! `WsCommands` — the serde-typed wire vocabulary (ADR-0005). Every
//! command carries a client-generated `request_id`, echoed on exactly
//! one reply — `ack`, `error`, or, for `get_state`, the `state` event
//! itself; broadcast `state`/`vis` events are pub/sub, id-less.

use ddp_engine::VisFrame;
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
    /// LAN access toggle (ADR-0012) — the root-scalar grammar, like
    /// `set_power`. Off severs the originator itself when it came
    /// through the LAN door: ack first, then the close.
    SetLanAccess {
        /// Correlation id echoed on the reply.
        request_id: String,
        /// The requested LAN access state.
        on: bool,
    },
    /// Select the active profile.
    SetProfile {
        /// Correlation id echoed on the reply.
        request_id: String,
        /// The profile to select.
        id: ddp_state::ProfileId,
    },
    /// The one sparse patch verb (ADR-0005): params and/or the EQ
    /// selection, atomic — an invalid part rejects the whole.
    EditProfile {
        /// Correlation id echoed on the reply.
        request_id: String,
        /// The profile to edit.
        id: ddp_state::ProfileId,
        /// A rename patch — absent = untouched; factory ids reject.
        #[serde(default)]
        name: Option<String>,
        /// The edited entries: `{ "<4-CC>": [i16, …] }`.
        #[serde(default)]
        params: std::collections::HashMap<String, Vec<i16>>,
        /// Tri-state EQ selection patch: absent = untouched, `null` =
        /// detach (the profile's own EQ params apply), id = select.
        #[serde(default, deserialize_with = "tri_state")]
        #[expect(
            clippy::option_option,
            reason = "tri-state: absent ≠ null ≠ id (ADR-0005)"
        )]
        selected_eq_preset: Option<Option<ddp_state::PresetId>>,
    },
    /// Create a custom profile from its content (ADR-0005) — never a
    /// source reference; the ack returns the server-minted id.
    AddProfile {
        /// Correlation id echoed on the reply.
        request_id: String,
        /// The display name — a label, not identity.
        name: String,
        /// The stated content params: `{ "<4-CC>": [i16, …] }`;
        /// unstated params resolve from the custom baseline.
        #[serde(default)]
        params: std::collections::HashMap<String, Vec<i16>>,
        /// The birth EQ selection; absent (or `null`) ⇒ no preset.
        #[serde(default)]
        selected_eq_preset: Option<ddp_state::PresetId>,
    },
    /// Create a custom EQ preset from its content — as `add_profile`,
    /// over the preset-carried params.
    AddEqPreset {
        /// Correlation id echoed on the reply.
        request_id: String,
        /// The display name.
        name: String,
        /// The stated content params: `{ "<4-CC>": [i16, …] }`.
        #[serde(default)]
        params: std::collections::HashMap<String, Vec<i16>>,
    },
    /// Drop the profile's `config.toml` divergences — whole-item, or
    /// `only` the named content keys (ADR-0007). Valid on every item.
    ResetProfile {
        /// Correlation id echoed on the reply.
        request_id: String,
        /// The profile to reset.
        id: ddp_state::ProfileId,
        /// The scope: absent ⇒ the whole item; present ⇒ exactly these
        /// content keys (param 4-CCs / `"selected_eq_preset"`). A key
        /// the profile doesn't carry rejects.
        #[serde(default)]
        only: Option<Vec<String>>,
    },
    /// Patch one EQ preset: a param map (preset-carried params only)
    /// and/or a rename.
    EditEqPreset {
        /// Correlation id echoed on the reply.
        request_id: String,
        /// The preset to edit.
        id: ddp_state::PresetId,
        /// A rename patch — absent = untouched; factory ids reject.
        #[serde(default)]
        name: Option<String>,
        /// The edited entries: `{ "<4-CC>": [i16, …] }`.
        #[serde(default)]
        params: std::collections::HashMap<String, Vec<i16>>,
    },
    /// Drop an EQ preset's `config.toml` divergences — as
    /// `reset_profile`, over the preset-carried params.
    ResetEqPreset {
        /// Correlation id echoed on the reply.
        request_id: String,
        /// The preset to reset.
        id: ddp_state::PresetId,
        /// The scope, over the params the preset carries.
        #[serde(default)]
        only: Option<Vec<String>>,
    },
    /// Delete a custom profile (factory ids reject).
    RemoveProfile {
        /// Correlation id echoed on the reply.
        request_id: String,
        /// The profile to delete.
        id: ddp_state::ProfileId,
    },
    /// Delete a custom EQ preset (factory ids reject); selecting
    /// profiles fall to explicit `None`.
    RemoveEqPreset {
        /// Correlation id echoed on the reply.
        request_id: String,
        /// The preset to delete.
        id: ddp_state::PresetId,
    },
}

/// Deserializes the tri-state `selected_eq_preset` patch: a present
/// key — `null` or an id — lands as `Some(…)`; `#[serde(default)]`
/// covers the absent (untouched) arm.
#[expect(
    clippy::option_option,
    reason = "tri-state: absent ≠ null ≠ id (ADR-0005)"
)]
fn tri_state<'de, D>(deserializer: D) -> Result<Option<Option<ddp_state::PresetId>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::deserialize(deserializer).map(Some)
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
        /// The echoed correlation id when this snapshot is the
        /// `get_state` reply (the total reply law, ADR-0005); absent
        /// on connect and broadcast — those are pub/sub.
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<&'a str>,
    },
    /// The per-block visualizer broadcast — the main session's vis
    /// tail; pub/sub to every client, no originator rule (ADR-0005).
    Vis {
        /// The tail's four arrays keyed by 4-CC, raw i16 1/16-dB.
        params: VisParams,
    },
    /// The one success reply per command — failures use
    /// [`WsEvent::Error`].
    Ack {
        /// The echoed correlation id.
        request_id: &'a str,
        /// The server-minted item id — present exactly on `add_*` acks,
        /// so the originator applies locally without waiting for a
        /// snapshot (ADR-0005).
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<&'a str>,
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

/// The `vis` event payload: a [`VisFrame`] as wire JSON — the same
/// `params: { "<4-CC>": [i16, …] }` shape the `edit_*` commands carry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct VisParams {
    /// Native-grid per-band EQ gains.
    vnbg: [i16; 20],
    /// Native-grid per-band spectrum excitations.
    vnbe: [i16; 20],
    /// Custom-grid per-band EQ gains.
    vcbg: [i16; 20],
    /// Custom-grid per-band spectrum excitations.
    vcbe: [i16; 20],
}

impl From<&VisFrame> for VisParams {
    fn from(frame: &VisFrame) -> Self {
        Self {
            vnbg: frame.vnbg,
            vnbe: frame.vnbe,
            vcbg: frame.vcbg,
            vcbe: frame.vcbe,
        }
    }
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

/// Builds the standard success reply; `minted` carries the fresh item
/// id on `add_*` acks.
pub(crate) fn ack<'a>(request_id: &'a str, minted: Option<&'a str>) -> WsEvent<'a> {
    WsEvent::Ack {
        request_id,
        id: minted,
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
