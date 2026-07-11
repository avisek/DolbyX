//! `State` — the daemon's user-facing state: power, selected profile
//! (profiles and EQ presets join in Slice 10,
//! [#18](https://github.com/avisek/DolbyX/issues/18)).
//!
//! Pure data + transitions, no I/O: [`State::apply`] is the single
//! mutation path, returning a [`StateDiff`] the daemon fans out to the
//! engine, persistence, and the WS broadcast.

use serde::Deserialize;

use crate::profile::ProfileId;

/// The factory root keys `defaults.toml` carries (profiles and EQ preset
/// tables join in Slice 10, [#18](https://github.com/avisek/DolbyX/issues/18)).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Defaults {
    /// Factory master power.
    pub power: bool,
    /// Factory selected profile.
    pub selected_profile: ProfileId,
}

/// The daemon's user-facing state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct State {
    /// Master power — `false` ⇒ every session is bypassed
    /// (`EFFECT_CMD_DISABLE`; parameter state survives the toggle).
    pub power: bool,
    /// The one active profile, applied to all sessions.
    pub selected_profile: ProfileId,
}

impl State {
    /// Builds the factory state — what a fresh install runs.
    #[must_use]
    pub fn new_from_defaults(defaults: &Defaults) -> Self {
        Self {
            power: defaults.power,
            selected_profile: defaults.selected_profile.clone(),
        }
    }

    /// Applies one mutation command, reporting what changed.
    ///
    /// # Errors
    ///
    /// Returns a [`ValidationError`] when the command is semantically
    /// invalid (none exist yet — the variants arrive with param editing
    /// and CRUD in later slices).
    pub fn apply(&mut self, command: Command) -> Result<StateDiff, ValidationError> {
        match command {
            Command::SetPower { on } => {
                let changed = self.power != on;
                self.power = on;
                Ok(StateDiff {
                    power: changed.then_some(on),
                })
            }
        }
    }
}

/// A state mutation — the WS `cmd` family, minus the read-only
/// `get_state` (which the WS layer answers with a snapshot directly).
/// (`Copy` holds until param-map variants land in later slices.)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    /// Master power toggle.
    SetPower {
        /// The requested power state.
        on: bool,
    },
}

/// What one [`State::apply`] changed — drives the engine fan-out, the
/// persistence flush, and the WS broadcast. Empty ⇒ the command was a
/// no-op and nothing downstream fires.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[must_use]
pub struct StateDiff {
    /// New power state, when it changed.
    pub power: Option<bool>,
}

impl StateDiff {
    /// `true` when the command changed nothing.
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.power.is_none()
    }
}

/// A semantically invalid command (unknown ids, out-of-range params, …)
/// — surfaced on the wire as `INVALID_REQUEST`. Uninhabited until those
/// arrive in later slices.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ValidationError {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::ProfileId;

    fn defaults() -> Defaults {
        Defaults {
            power: true,
            selected_profile: ProfileId("music".into()),
        }
    }

    #[test]
    fn new_from_defaults_copies_the_root_keys() {
        let state = State::new_from_defaults(&defaults());
        assert!(state.power);
        assert_eq!(state.selected_profile, ProfileId("music".into()));
    }

    #[test]
    fn set_power_flips_power_and_reports_the_change() {
        let mut state = State::new_from_defaults(&defaults());
        let diff = state.apply(Command::SetPower { on: false }).unwrap();
        assert!(!state.power);
        assert_eq!(diff.power, Some(false));
    }

    #[test]
    fn set_power_to_the_current_value_is_a_no_op() {
        let mut state = State::new_from_defaults(&defaults());
        let diff = state.apply(Command::SetPower { on: true }).unwrap();
        assert!(state.power);
        assert!(diff.is_empty());
    }
}
