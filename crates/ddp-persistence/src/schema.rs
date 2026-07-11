//! On-disk TOML schemas: `defaults.toml` (factory truth, read-only) and
//! `config.toml` (the user's overlay — root keys only until Slice 10,
//! [#18](https://github.com/avisek/DolbyX/issues/18)).
//!
//! Overlay semantics (ADR-0007): `config.toml` stores only divergences
//! from what resolves beneath it, so a factory-fresh install is an
//! **empty** file and user diffs stay small and inspectable.

use ddp_state::{Defaults, ProfileId, State};
use serde::{Deserialize, Serialize};

use crate::Error;

/// The user's root-key overlay — every field optional; absent ⇒ the
/// factory value resolves.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigOverlay {
    /// Master power, when diverging from factory.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub power: Option<bool>,
    /// Selected profile, when diverging from factory.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_profile: Option<ProfileId>,
}

/// Parses `defaults.toml` — complete and strict: a missing or unknown
/// key is a startup-refusing error.
///
/// # Errors
///
/// [`Error::Defaults`] when the document is malformed.
pub fn parse_defaults(document: &str) -> Result<Defaults, Error> {
    toml::from_str(document).map_err(Error::Defaults)
}

/// Parses `config.toml` — sparse by design (empty on a fresh install),
/// but strict about unknown keys so a hand-edit typo fails loudly.
///
/// # Errors
///
/// [`Error::Config`] when the document is malformed.
pub fn parse_config(document: &str) -> Result<ConfigOverlay, Error> {
    toml::from_str(document).map_err(Error::Config)
}

/// Resolves the user overlay over the factory defaults into a [`State`].
#[must_use]
pub fn resolve(defaults: &Defaults, overlay: &ConfigOverlay) -> State {
    let mut state = State::new_from_defaults(defaults);
    if let Some(power) = overlay.power {
        state.power = power;
    }
    if let Some(profile) = &overlay.selected_profile {
        state.selected_profile = profile.clone();
    }
    state
}

/// Serializes the divergence of `state` from `defaults` — the exact
/// bytes `config.toml` should hold. Factory-matching fields are omitted;
/// no divergence ⇒ the empty string (a 0-byte file).
///
/// # Panics
///
/// Never in practice: a root-key overlay always serializes to TOML.
#[must_use]
pub fn serialize_overlay(state: &State, defaults: &Defaults) -> String {
    let overlay = ConfigOverlay {
        power: (state.power != defaults.power).then_some(state.power),
        selected_profile: (state.selected_profile != defaults.selected_profile)
            .then(|| state.selected_profile.clone()),
    };
    toml::to_string(&overlay).expect("root-key overlay always serializes")
}

#[cfg(test)]
mod tests {
    use super::*;
    use ddp_state::{Command, ProfileId, State};

    const DEFAULTS: &str = "power = true\nselected_profile = \"music\"\n";

    #[test]
    fn parses_defaults() {
        let defaults = parse_defaults(DEFAULTS).unwrap();
        assert!(defaults.power);
        assert_eq!(defaults.selected_profile, ProfileId("music".into()));
    }

    #[test]
    fn rejects_malformed_or_incomplete_defaults() {
        for bad in [
            "power = true",
            "power = tru",
            "power = true\nselected_profile = \"music\"\nx = 1",
        ] {
            let err = parse_defaults(bad).unwrap_err().to_string();
            assert!(err.contains("defaults.toml"), "no file context: {err}");
        }
    }

    #[test]
    fn parses_an_empty_config_as_no_overlay() {
        let overlay = parse_config("").unwrap();
        assert_eq!(overlay, ConfigOverlay::default());
    }

    #[test]
    fn parses_a_partial_config_overlay() {
        let overlay = parse_config("power = false\n").unwrap();
        assert_eq!(overlay.power, Some(false));
        assert_eq!(overlay.selected_profile, None);
    }

    #[test]
    fn rejects_an_unknown_config_key() {
        // Hand-edits are supported; a typo must fail loudly, not be
        // silently ignored.
        let err = parse_config("powr = false\n").unwrap_err().to_string();
        assert!(err.contains("config.toml"), "no file context: {err}");
    }

    #[test]
    fn resolves_the_overlay_over_the_defaults() {
        let defaults = parse_defaults(DEFAULTS).unwrap();
        let factory = resolve(&defaults, &ConfigOverlay::default());
        assert_eq!(factory, State::new_from_defaults(&defaults));

        let overlay = parse_config("power = false\n").unwrap();
        let state = resolve(&defaults, &overlay);
        assert!(!state.power);
        assert_eq!(state.selected_profile, ProfileId("music".into()));
    }

    #[test]
    fn serializes_only_divergences_from_factory() {
        let defaults = parse_defaults(DEFAULTS).unwrap();
        let mut state = State::new_from_defaults(&defaults);
        assert_eq!(serialize_overlay(&state, &defaults), "");

        let _ = state.apply(Command::SetPower { on: false }).unwrap();
        assert_eq!(serialize_overlay(&state, &defaults), "power = false\n");
    }
}
