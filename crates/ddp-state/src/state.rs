//! `State` — the daemon's user-facing state: power, factory profiles,
//! the selected profile (EQ presets join in Slice 15,
//! [#23](https://github.com/avisek/DolbyX/issues/23)).
//!
//! Pure data + transitions, no I/O: [`State::apply`] is the single
//! mutation path, returning a [`StateDiff`] the daemon fans out to the
//! engine, persistence, and the WS broadcast.

use std::collections::HashMap;

use crate::param_def::{ParameterDef, lookup};
use crate::profile::{Profile, ProfileId};

/// The factory truth `defaults.toml` resolves to at startup: root keys
/// plus the factory profiles, each complete over `ParameterDef.default`
/// (EQ preset tables join in Slice 15,
/// [#23](https://github.com/avisek/DolbyX/issues/23)).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Defaults {
    /// Factory master power.
    pub power: bool,
    /// Factory selected profile.
    pub selected_profile: ProfileId,
    /// Factory profiles in declaration order, `params` fully resolved
    /// (`ParameterDef.default` ⊕ shared ⊕ item), `baseline == params`.
    pub profiles: Vec<Profile>,
}

/// The daemon's user-facing state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct State {
    /// Master power — `false` ⇒ every session is bypassed
    /// (`EFFECT_CMD_DISABLE`; parameter state survives the toggle).
    pub power: bool,
    /// The one active profile, applied to all sessions. Invariant: it
    /// always names an entry of `profiles`.
    pub selected_profile: ProfileId,
    /// Every profile, factory first (custom profiles join in Slice 18,
    /// [#26](https://github.com/avisek/DolbyX/issues/26)).
    pub profiles: Vec<Profile>,
}

impl State {
    /// Builds the factory state — what a fresh install runs.
    #[must_use]
    pub fn new_from_defaults(defaults: &Defaults) -> Self {
        Self {
            power: defaults.power,
            selected_profile: defaults.selected_profile.clone(),
            profiles: defaults.profiles.clone(),
        }
    }

    /// Finds a profile by id.
    #[must_use]
    pub fn profile(&self, id: &ProfileId) -> Option<&Profile> {
        self.profiles.iter().find(|profile| profile.id == *id)
    }

    fn profile_mut(&mut self, id: &ProfileId) -> Option<&mut Profile> {
        self.profiles.iter_mut().find(|profile| profile.id == *id)
    }

    /// The selected profile.
    ///
    /// # Panics
    ///
    /// Never in practice: `selected_profile` always names an existing
    /// profile (load rejects a dangling selection; `SetProfile`
    /// validates).
    #[must_use]
    pub fn selected(&self) -> &Profile {
        self.profile(&self.selected_profile)
            .expect("selected_profile names an existing profile")
    }

    /// The selected profile's complete engine batch — every writable
    /// param in `defs` order (structural counts and frequencies land
    /// before their group's commit leaf, per the table's layout).
    ///
    /// # Panics
    ///
    /// Never in practice: profiles seed every writable param of the
    /// table they were resolved against.
    #[must_use]
    pub fn resolved_batch(&self, defs: &[ParameterDef]) -> Vec<(String, Vec<i16>)> {
        let profile = self.selected();
        defs.iter()
            .filter(|def| def.access.is_writable())
            .map(|def| {
                let values = profile
                    .params
                    .get(&def.name)
                    .unwrap_or_else(|| panic!("`{}` missing from the resolved profile", def.name));
                (def.name.clone(), values.clone())
            })
            .collect()
    }

    /// Applies one mutation command, reporting what changed. `defs` is
    /// the `ParameterDef` table — the single source of truth every
    /// param write validates against.
    ///
    /// # Errors
    ///
    /// Returns a [`ValidationError`] when the command is semantically
    /// invalid (unknown ids, undeclared/read-only params, shape or
    /// range violations) — the state is left untouched.
    pub fn apply(
        &mut self,
        command: Command,
        defs: &[ParameterDef],
    ) -> Result<StateDiff, ValidationError> {
        match command {
            Command::SetPower { on } => {
                let changed = self.power != on;
                self.power = on;
                Ok(StateDiff {
                    power: changed.then_some(on),
                    params: None,
                    changed,
                })
            }
            Command::SetProfile { id } => {
                if self.profile(&id).is_none() {
                    return Err(ValidationError::UnknownProfile(id.0));
                }
                if self.selected_profile == id {
                    return Ok(StateDiff::default());
                }
                self.selected_profile = id;
                Ok(StateDiff {
                    power: None,
                    params: Some(self.resolved_batch(defs)),
                    changed: true,
                })
            }
            Command::EditProfile { id, params } => {
                // Validate everything before mutating anything.
                for (name, values) in &params {
                    validate_write(defs, name, values)?;
                }
                let live = self.selected_profile == id;
                let profile = self
                    .profile_mut(&id)
                    .ok_or(ValidationError::UnknownProfile(id.0))?;
                // Table order: structural counts precede their group's
                // commit leaf, so a genb+gebg edit reshapes correctly.
                let mut batch = Vec::with_capacity(params.len());
                let mut changed = false;
                for def in defs {
                    let Some(values) = params.get(&def.name) else {
                        continue;
                    };
                    if profile.params[&def.name][..values.len()] != values[..] {
                        profile.splice(&def.name, values);
                        changed = true;
                    }
                    batch.push((def.name.clone(), values.clone()));
                }
                Ok(StateDiff {
                    power: None,
                    params: (changed && live).then_some(batch),
                    changed,
                })
            }
            Command::ResetProfile { id } => {
                let live = self.selected_profile == id;
                let profile = self
                    .profile_mut(&id)
                    .ok_or(ValidationError::UnknownProfile(id.0))?;
                if profile.params == profile.baseline {
                    return Ok(StateDiff::default());
                }
                profile.params = profile.baseline.clone();
                Ok(StateDiff {
                    power: None,
                    params: live.then(|| self.resolved_batch(defs)),
                    changed: true,
                })
            }
        }
    }
}

/// A state mutation — the WS `cmd` family, minus the read-only
/// `get_state` (which the WS layer answers with a snapshot directly).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    /// Master power toggle.
    SetPower {
        /// The requested power state.
        on: bool,
    },
    /// Selects the active profile (global — all sessions follow).
    SetProfile {
        /// The profile to select.
        id: ProfileId,
    },
    /// Writes a param map into one profile; flushes to the engine only
    /// when that profile is selected.
    EditProfile {
        /// The profile to edit.
        id: ProfileId,
        /// The edited entries, keyed by 4-CC.
        params: HashMap<String, Vec<i16>>,
    },
    /// Drops a profile's own overrides, restoring its baseline (factory
    /// rows in `defaults.toml` stay untouched).
    ResetProfile {
        /// The profile to reset.
        id: ProfileId,
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
    /// One atomic engine batch, when the engine must hear the change: a
    /// profile switch or reset carries the full resolved set, a live
    /// edit carries the edited entries (a single control edit is a
    /// 1-entry batch — never a dribble).
    pub params: Option<Vec<(String, Vec<i16>)>>,
    /// Whether any persistent state changed (⇒ flush + broadcast even
    /// when the engine hears nothing, e.g. an edit to a non-selected
    /// profile).
    pub changed: bool,
}

impl StateDiff {
    /// `true` when the command changed nothing.
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        !self.changed
    }
}

/// A semantically invalid command — surfaced on the wire as
/// `INVALID_REQUEST`, with the state left untouched.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ValidationError {
    /// The profile id names no profile.
    #[error("unknown profile `{0}`")]
    UnknownProfile(String),
    /// The 4-CC names no declared parameter.
    #[error("unknown parameter `{0}`")]
    UnknownParam(String),
    /// The parameter is read-only (`ReadOnly-Dynamic`/`ReadOnly-Static`).
    #[error("parameter `{0}` is read-only")]
    ReadOnlyParam(String),
    /// The value array is empty or exceeds the declared allocation.
    #[error("parameter `{name}`: {actual} values, allocation is {length}")]
    WrongLength {
        /// The offending parameter.
        name: String,
        /// Its declared allocation.
        length: usize,
        /// How many values the write carried.
        actual: usize,
    },
    /// A value lies outside the declared `[min, max]`.
    #[error("parameter `{name}`: value[{index}] = {value} outside [{min}, {max}]")]
    OutOfRange {
        /// The offending parameter.
        name: String,
        /// The first out-of-range slot.
        index: usize,
        /// Its value.
        value: i16,
        /// The declared lower bound.
        min: i16,
        /// The declared upper bound.
        max: i16,
    },
}

/// Validates one param write against the `ParameterDef` table: the 4-CC
/// is declared and writable, the shape fits the allocation (1 ⩽ n ⩽
/// `length` — shorter band arrays overlay the head), every value in
/// `[min, max]`. The engine never rejects values — it silently clamps —
/// so this is the only value validation anywhere (ADR-0005).
///
/// # Errors
///
/// The first violated rule, as a [`ValidationError`].
pub fn validate_write(
    defs: &[ParameterDef],
    name: &str,
    values: &[i16],
) -> Result<(), ValidationError> {
    let def = lookup(defs, name).ok_or_else(|| ValidationError::UnknownParam(name.into()))?;
    if !def.access.is_writable() {
        return Err(ValidationError::ReadOnlyParam(name.into()));
    }
    if values.is_empty() || values.len() > def.length {
        return Err(ValidationError::WrongLength {
            name: name.into(),
            length: def.length,
            actual: values.len(),
        });
    }
    let bounds = def.min..=def.max;
    if let Some((index, &value)) = values
        .iter()
        .enumerate()
        .find(|(_, value)| !bounds.contains(value))
    {
        return Err(ValidationError::OutOfRange {
            name: name.into(),
            index,
            value,
            min: def.min,
            max: def.max,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::param_def::{ParamAccess, ParamCategory, ParamKind, base_params};

    /// A compact stand-in for the 64-entry table: two scalars, one band
    /// array (allocation 4, like the real 40), one experimental, one
    /// read-only.
    fn defs() -> Vec<ParameterDef> {
        let def = |name: &str, length: usize, min: i16, max: i16, default: Vec<i16>, access| {
            ParameterDef {
                name: name.into(),
                length,
                min,
                max,
                frac_bits: 0,
                default,
                kind: ParamKind::Integer,
                category: ParamCategory::VolumeLeveller,
                access,
                label: name.to_uppercase(),
                description: String::new(),
                help: String::new(),
            }
        };
        vec![
            def("dvla", 1, 0, 10, vec![7], ParamAccess::Settable),
            def("genb", 1, 1, 4, vec![2], ParamAccess::Settable),
            def("gebg", 4, -576, 576, vec![0; 4], ParamAccess::Settable),
            def("ven", 1, 0, 1, vec![0], ParamAccess::Experimental),
            def("vnnb", 1, 1, 20, vec![20], ParamAccess::ReadOnlyStatic),
        ]
    }

    fn profile(id: &str, name: &str, table: &[ParameterDef]) -> Profile {
        let params = base_params(table);
        Profile {
            id: ProfileId(id.into()),
            name: name.into(),
            selected_eq_preset: None,
            is_factory: true,
            params: params.clone(),
            baseline: params,
        }
    }

    fn defaults() -> Defaults {
        let table = defs();
        let mut music = profile("music", "Music", &table);
        music.splice("dvla", &[4]);
        music.baseline = music.params.clone();
        Defaults {
            power: true,
            selected_profile: ProfileId("music".into()),
            profiles: vec![profile("movie", "Movie", &table), music],
        }
    }

    /// Behavior 2 (issue #18): a fresh install runs the factory state —
    /// `music` selected, profiles complete.
    #[test]
    fn new_from_defaults_selects_music_with_complete_profiles() {
        let state = State::new_from_defaults(&defaults());
        assert!(state.power);
        assert_eq!(state.selected_profile, ProfileId("music".into()));
        assert_eq!(state.profiles.len(), 2);
        assert_eq!(state.selected().name, "Music");
        assert_eq!(state.selected().params["dvla"], vec![4]);
        assert!(state.selected().is_factory);
        assert_eq!(state.selected().selected_eq_preset, None);
    }

    #[test]
    fn set_power_flips_power_and_reports_the_change() {
        let mut state = State::new_from_defaults(&defaults());
        let diff = state
            .apply(Command::SetPower { on: false }, &defs())
            .unwrap();
        assert!(!state.power);
        assert_eq!(diff.power, Some(false));
        assert!(!diff.is_empty());
    }

    #[test]
    fn set_power_to_the_current_value_is_a_no_op() {
        let mut state = State::new_from_defaults(&defaults());
        let diff = state
            .apply(Command::SetPower { on: true }, &defs())
            .unwrap();
        assert!(state.power);
        assert!(diff.is_empty());
    }

    /// Behavior 4 (issue #18): a switch updates the selection and hands
    /// the engine the target's full resolved set — every writable param
    /// in table order, one atomic batch.
    #[test]
    fn set_profile_switches_and_batches_the_full_resolved_set() {
        let mut state = State::new_from_defaults(&defaults());
        let diff = state
            .apply(
                Command::SetProfile {
                    id: ProfileId("movie".into()),
                },
                &defs(),
            )
            .unwrap();
        assert_eq!(state.selected_profile, ProfileId("movie".into()));
        assert_eq!(
            diff.params.unwrap(),
            vec![
                ("dvla".to_string(), vec![7_i16]), // movie runs the base default
                ("genb".to_string(), vec![2]),
                ("gebg".to_string(), vec![0; 4]),
                ("ven".to_string(), vec![0]),
                // vnnb is read-only: never in a profile batch
            ],
        );
    }

    /// Behavior 9 (issue #18): an unknown id is rejected with the state
    /// untouched.
    #[test]
    fn set_profile_with_an_unknown_id_is_rejected_unchanged() {
        let mut state = State::new_from_defaults(&defaults());
        let before = state.clone();
        let error = state
            .apply(
                Command::SetProfile {
                    id: ProfileId("nonexistent".into()),
                },
                &defs(),
            )
            .unwrap_err();
        assert_eq!(error, ValidationError::UnknownProfile("nonexistent".into()));
        assert_eq!(error.to_string(), "unknown profile `nonexistent`");
        assert_eq!(state, before);
    }

    #[test]
    fn set_profile_to_the_current_selection_is_a_no_op() {
        let mut state = State::new_from_defaults(&defaults());
        let diff = state
            .apply(
                Command::SetProfile {
                    id: ProfileId("music".into()),
                },
                &defs(),
            )
            .unwrap();
        assert!(diff.is_empty());
        assert_eq!(diff.params, None);
    }

    fn edit(id: &str, entries: &[(&str, &[i16])]) -> Command {
        Command::EditProfile {
            id: ProfileId(id.into()),
            params: entries
                .iter()
                .map(|&(name, values)| (name.to_string(), values.to_vec()))
                .collect(),
        }
    }

    /// Behavior 5 (issue #18), live half: an edit to the selected
    /// profile merges and hands the engine exactly the edited entries —
    /// in table order, so structural counts precede their commit leaf.
    #[test]
    fn edit_on_the_selected_profile_merges_and_batches_the_entries() {
        let mut state = State::new_from_defaults(&defaults());
        let diff = state
            .apply(
                edit("music", &[("gebg", &[5, -5]), ("genb", &[4])]),
                &defs(),
            )
            .unwrap();
        assert_eq!(
            diff.params.unwrap(),
            vec![
                ("genb".to_string(), vec![4_i16]),
                ("gebg".to_string(), vec![5, -5]),
            ],
            "entries land in table order, not command order"
        );
        let music = state.selected();
        assert_eq!(music.params["genb"], vec![4]);
        assert_eq!(
            music.params["gebg"],
            vec![5, -5, 0, 0],
            "short band arrays overlay the head of the full allocation"
        );
        assert_eq!(music.baseline["gebg"], vec![0; 4], "baseline untouched");
    }

    /// Behavior 5 (issue #18), offline half: an edit to a non-selected
    /// profile persists but never touches the engine.
    #[test]
    fn edit_on_a_non_selected_profile_changes_state_without_a_batch() {
        let mut state = State::new_from_defaults(&defaults());
        let diff = state
            .apply(edit("movie", &[("dvla", &[3])]), &defs())
            .unwrap();
        assert!(!diff.is_empty(), "the change must flush + broadcast");
        assert_eq!(diff.params, None, "…but the engine hears nothing");
        assert_eq!(
            state.profile(&ProfileId("movie".into())).unwrap().params["dvla"],
            vec![3]
        );
    }

    #[test]
    fn edit_writing_the_current_values_is_a_no_op() {
        let mut state = State::new_from_defaults(&defaults());
        let diff = state
            .apply(edit("music", &[("dvla", &[4])]), &defs())
            .unwrap();
        assert!(diff.is_empty());
    }

    /// The epic's validation section: every entry checked against
    /// `ParameterDef` up front — the engine clamps instead of rejecting,
    /// so the daemon is the only guard. Failure leaves state untouched.
    #[test]
    fn edit_validation_rejects_bad_entries_with_state_untouched() {
        let mut state = State::new_from_defaults(&defaults());
        let before = state.clone();
        let rejected = [
            (
                edit("ghost", &[("dvla", &[4])]),
                ValidationError::UnknownProfile("ghost".into()),
            ),
            (
                edit("music", &[("mxou", &[1])]),
                ValidationError::UnknownParam("mxou".into()),
            ),
            (
                edit("music", &[("vnnb", &[10])]),
                ValidationError::ReadOnlyParam("vnnb".into()),
            ),
            (
                edit("music", &[("gebg", &[0; 5])]),
                ValidationError::WrongLength {
                    name: "gebg".into(),
                    length: 4,
                    actual: 5,
                },
            ),
            (
                edit("music", &[("gebg", &[])]),
                ValidationError::WrongLength {
                    name: "gebg".into(),
                    length: 4,
                    actual: 0,
                },
            ),
            (
                edit("music", &[("dvla", &[11])]),
                ValidationError::OutOfRange {
                    name: "dvla".into(),
                    index: 0,
                    value: 11,
                    min: 0,
                    max: 10,
                },
            ),
        ];
        for (command, expected) in rejected {
            assert_eq!(state.apply(command, &defs()), Err(expected));
            assert_eq!(state, before, "a rejected edit must not mutate");
        }
    }

    /// Behavior 8 (issue #18): reset restores the baseline (what
    /// resolves beneath the profile's own overrides); live ⇒ the engine
    /// gets the restored full set.
    #[test]
    fn reset_restores_the_baseline_and_batches_when_live() {
        let mut state = State::new_from_defaults(&defaults());
        let _ = state
            .apply(edit("music", &[("dvla", &[9])]), &defs())
            .unwrap();

        let diff = state
            .apply(
                Command::ResetProfile {
                    id: ProfileId("music".into()),
                },
                &defs(),
            )
            .unwrap();
        assert_eq!(state.selected().params["dvla"], vec![4], "factory value");
        let batch = diff.params.expect("live reset flushes the full set");
        assert!(batch.contains(&("dvla".to_string(), vec![4])));

        // Non-selected: state changes, engine hears nothing.
        let _ = state
            .apply(edit("movie", &[("dvla", &[1])]), &defs())
            .unwrap();
        let diff = state
            .apply(
                Command::ResetProfile {
                    id: ProfileId("movie".into()),
                },
                &defs(),
            )
            .unwrap();
        assert!(!diff.is_empty());
        assert_eq!(diff.params, None);

        // Nothing diverging ⇒ a reset is a no-op.
        let diff = state
            .apply(
                Command::ResetProfile {
                    id: ProfileId("music".into()),
                },
                &defs(),
            )
            .unwrap();
        assert!(diff.is_empty());

        assert_eq!(
            state.apply(
                Command::ResetProfile {
                    id: ProfileId("ghost".into()),
                },
                &defs(),
            ),
            Err(ValidationError::UnknownProfile("ghost".into())),
        );
    }
}
