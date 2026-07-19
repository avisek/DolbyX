//! `State` — the daemon's user-facing state: power, factory profiles,
//! the selected profile, and the global EQ presets.
//!
//! Pure data + transitions, no I/O: [`State::apply`] is the single
//! mutation path, returning a [`StateDiff`] the daemon fans out to the
//! engine, persistence, and the WS broadcast.

use std::collections::HashMap;

use crate::param_def::{ParameterDef, lookup};
use crate::preset::{EqPreset, PresetId};
use crate::profile::{Profile, ProfileId};

/// The factory truth `defaults.toml` resolves to at startup: root keys
/// plus the factory profiles and EQ presets, each complete over
/// `ParameterDef.default`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Defaults {
    /// Factory master power.
    pub power: bool,
    /// Factory selected profile.
    pub selected_profile: ProfileId,
    /// Factory profiles in declaration order, `params` fully resolved
    /// (`ParameterDef.default` ⊕ shared ⊕ item), `baseline == params`.
    pub profiles: Vec<Profile>,
    /// Factory EQ presets in declaration order, resolved the same way
    /// over the preset-carried params.
    pub eq_presets: Vec<EqPreset>,
    /// What resolves beneath a custom profile's own `config.toml`
    /// overrides at this layer: `ParameterDef.default` ⊕ the
    /// `defaults.toml` shared params (custom items have no
    /// `defaults.toml` row; `config.toml`'s shared layer joins at
    /// resolve).
    pub custom_profile_baseline: HashMap<String, Vec<i16>>,
    /// The EQ preset counterpart, over the preset-carried params.
    pub custom_eq_preset_baseline: HashMap<String, Vec<i16>>,
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
    /// Every profile, factory first, custom after in creation order.
    /// Invariant: every `Some` `selected_eq_preset` names an entry of
    /// `eq_presets` (load rejects a dangling selection; `SetEqPreset`
    /// validates; `RemoveEqPreset` falls selectors back to `None`).
    pub profiles: Vec<Profile>,
    /// Every EQ preset, factory first, custom after in creation order —
    /// global across profiles.
    pub eq_presets: Vec<EqPreset>,
    /// The baseline every custom profile is born with and resets never
    /// touch (reset is factory-only): what resolves beneath a custom
    /// item's own overrides — [`Defaults::custom_profile_baseline`] ⊕
    /// `config.toml` shared.
    pub custom_profile_baseline: HashMap<String, Vec<i16>>,
    /// The EQ preset counterpart, over the preset-carried params.
    pub custom_eq_preset_baseline: HashMap<String, Vec<i16>>,
    /// Where the selection falls when the selected profile is removed —
    /// `defaults.toml`'s `selected_profile` (a factory id, so it can
    /// never itself be removed).
    pub fallback_profile: ProfileId,
}

impl State {
    /// Builds the factory state — what a fresh install runs.
    #[must_use]
    pub fn new_from_defaults(defaults: &Defaults) -> Self {
        Self {
            power: defaults.power,
            selected_profile: defaults.selected_profile.clone(),
            profiles: defaults.profiles.clone(),
            eq_presets: defaults.eq_presets.clone(),
            custom_profile_baseline: defaults.custom_profile_baseline.clone(),
            custom_eq_preset_baseline: defaults.custom_eq_preset_baseline.clone(),
            fallback_profile: defaults.selected_profile.clone(),
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

    /// Finds an EQ preset by id.
    #[must_use]
    pub fn eq_preset(&self, id: &PresetId) -> Option<&EqPreset> {
        self.eq_presets.iter().find(|preset| preset.id == *id)
    }

    fn eq_preset_mut(&mut self, id: &PresetId) -> Option<&mut EqPreset> {
        self.eq_presets.iter_mut().find(|preset| preset.id == *id)
    }

    /// The EQ preset overlaying `profile`, when one is selected.
    ///
    /// # Panics
    ///
    /// Never in practice: every `Some` selection names an existing
    /// preset (load rejects a dangling selection; `SetEqPreset`
    /// validates).
    fn overlay_of(&self, profile: &Profile) -> Option<&EqPreset> {
        profile.selected_eq_preset.as_ref().map(|id| {
            self.eq_preset(id)
                .expect("selected_eq_preset names an existing preset")
        })
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
    /// before their group's commit leaf, per the table's layout). A
    /// selected EQ preset's params shadow the profile's own *entirely*
    /// (ADR-0003).
    ///
    /// # Panics
    ///
    /// Never in practice: profiles and presets seed every param of the
    /// table they were resolved against.
    #[must_use]
    pub fn resolved_batch(&self, defs: &[ParameterDef]) -> Vec<(String, Vec<i16>)> {
        let profile = self.selected();
        let overlay = self.overlay_of(profile);
        defs.iter()
            .filter(|def| def.access.is_writable())
            .map(|def| {
                let params = match overlay {
                    Some(preset) if def.category.is_preset_carried() => &preset.params,
                    _ => &profile.params,
                };
                let values = params
                    .get(&def.name)
                    .unwrap_or_else(|| panic!("`{}` missing from the resolved item", def.name));
                (def.name.clone(), values.clone())
            })
            .collect()
    }

    /// The selected profile's effective EQ batch — the preset-carried
    /// subset of [`State::resolved_batch`]: the selected preset's
    /// params when one is selected, else the profile's own — what a
    /// live EQ preset switch/detach/reset flushes.
    fn eq_batch(&self, defs: &[ParameterDef]) -> Vec<(String, Vec<i16>)> {
        self.resolved_batch(defs)
            .into_iter()
            .filter(|(name, _)| {
                lookup(defs, name).is_some_and(|def| def.category.is_preset_carried())
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
                    minted_id: None,
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
                    minted_id: None,
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
                let overlaid = profile.selected_eq_preset.is_some();
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
                    // A selected preset shadows the profile's own EQ
                    // params entirely — the engine must not hear a
                    // shadowed write (ADR-0003).
                    if !(overlaid && def.category.is_preset_carried()) {
                        batch.push((def.name.clone(), values.clone()));
                    }
                }
                Ok(StateDiff {
                    power: None,
                    params: (changed && live && !batch.is_empty()).then_some(batch),
                    changed,
                    minted_id: None,
                })
            }
            Command::ResetProfile { id } => {
                let live = self.selected_profile == id;
                let profile = self
                    .profile_mut(&id)
                    .ok_or_else(|| ValidationError::UnknownProfile(id.0.clone()))?;
                if !profile.is_factory {
                    return Err(ValidationError::ResetCustom {
                        kind: ItemKind::Profile,
                        id: id.0,
                    });
                }
                if profile.params == profile.baseline && profile.selected_eq_preset.is_none() {
                    return Ok(StateDiff::default());
                }
                profile.params = profile.baseline.clone();
                // The selection is a config.toml override like any
                // other — factory selection ships `None` (issue #23).
                profile.selected_eq_preset = None;
                Ok(StateDiff {
                    power: None,
                    params: live.then(|| self.resolved_batch(defs)),
                    changed: true,
                    minted_id: None,
                })
            }
            Command::SetEqPreset { profile_id, id } => self.set_eq_preset(profile_id, id, defs),
            Command::EditEqPreset { id, params } => self.edit_eq_preset(id, &params, defs),
            Command::ResetEqPreset { id } => self.reset_eq_preset(id, defs),
            Command::AddProfile { from, name } => self.add_profile(&from, &name),
            Command::RenameProfile { id, name } => self.rename_profile(&id, &name),
            Command::RemoveProfile { id } => self.remove_profile(&id, defs),
            Command::AddEqPreset { from, name } => self.add_eq_preset(&from, &name),
            Command::RenameEqPreset { id, name } => self.rename_eq_preset(&id, &name),
            Command::RemoveEqPreset { id } => self.remove_eq_preset(&id, defs),
        }
    }

    /// [`Command::AddProfile`]: clone the source under a minted id —
    /// resolved params and EQ preset selection both, so the clone
    /// sounds identical; its divergence base is the custom baseline.
    fn add_profile(&mut self, from: &ProfileId, name: &str) -> Result<StateDiff, ValidationError> {
        let name = valid_name(name)?;
        let source = self
            .profile(from)
            .ok_or_else(|| ValidationError::UnknownProfile(from.0.clone()))?;
        let id = mint_id(&name, |id| self.profiles.iter().any(|p| p.id.0 == id));
        let clone = Profile {
            id: ProfileId(id.clone()),
            name,
            selected_eq_preset: source.selected_eq_preset.clone(),
            is_factory: false,
            params: source.params.clone(),
            baseline: self.custom_profile_baseline.clone(),
        };
        self.profiles.push(clone);
        Ok(StateDiff {
            power: None,
            params: None, // never selected at birth — the engine is silent
            changed: true,
            minted_id: Some(id),
        })
    }

    /// [`Command::RenameProfile`]: update the display name — custom
    /// items only, the id untouched.
    fn rename_profile(&mut self, id: &ProfileId, name: &str) -> Result<StateDiff, ValidationError> {
        let name = valid_name(name)?;
        let profile = self
            .profile_mut(id)
            .ok_or_else(|| ValidationError::UnknownProfile(id.0.clone()))?;
        if profile.is_factory {
            return Err(ValidationError::FactoryImmutable {
                kind: ItemKind::Profile,
                id: id.0.clone(),
            });
        }
        if profile.name == name {
            return Ok(StateDiff::default());
        }
        profile.name = name;
        Ok(StateDiff {
            power: None,
            params: None, // a rename never touches the engine
            changed: true,
            minted_id: None,
        })
    }

    /// [`Command::RemoveProfile`]: drop a custom profile. Removing the
    /// selected one falls the selection back to
    /// [`State::fallback_profile`], the engine getting that profile's
    /// full resolved set.
    fn remove_profile(
        &mut self,
        id: &ProfileId,
        defs: &[ParameterDef],
    ) -> Result<StateDiff, ValidationError> {
        let profile = self
            .profile(id)
            .ok_or_else(|| ValidationError::UnknownProfile(id.0.clone()))?;
        if profile.is_factory {
            return Err(ValidationError::FactoryImmutable {
                kind: ItemKind::Profile,
                id: id.0.clone(),
            });
        }
        let was_selected = self.selected_profile == *id;
        self.profiles.retain(|profile| profile.id != *id);
        if was_selected {
            self.selected_profile = self.fallback_profile.clone();
        }
        Ok(StateDiff {
            power: None,
            params: was_selected.then(|| self.resolved_batch(defs)),
            changed: true,
            minted_id: None,
        })
    }

    /// [`Command::AddEqPreset`]: clone the source under a minted id —
    /// [`State::add_profile`]'s preset mirror (no selection to clone:
    /// selections live on profiles).
    fn add_eq_preset(&mut self, from: &PresetId, name: &str) -> Result<StateDiff, ValidationError> {
        let name = valid_name(name)?;
        let source = self
            .eq_preset(from)
            .ok_or_else(|| ValidationError::UnknownEqPreset(from.0.clone()))?;
        let id = mint_id(&name, |id| self.eq_presets.iter().any(|p| p.id.0 == id));
        let clone = EqPreset {
            id: PresetId(id.clone()),
            name,
            is_factory: false,
            params: source.params.clone(),
            baseline: self.custom_eq_preset_baseline.clone(),
        };
        self.eq_presets.push(clone);
        Ok(StateDiff {
            power: None,
            params: None, // nothing selects it at birth — the engine is silent
            changed: true,
            minted_id: Some(id),
        })
    }

    /// [`Command::RenameEqPreset`]: [`State::rename_profile`]'s preset
    /// mirror.
    fn rename_eq_preset(
        &mut self,
        id: &PresetId,
        name: &str,
    ) -> Result<StateDiff, ValidationError> {
        let name = valid_name(name)?;
        let preset = self
            .eq_preset_mut(id)
            .ok_or_else(|| ValidationError::UnknownEqPreset(id.0.clone()))?;
        if preset.is_factory {
            return Err(ValidationError::FactoryImmutable {
                kind: ItemKind::EqPreset,
                id: id.0.clone(),
            });
        }
        if preset.name == name {
            return Ok(StateDiff::default());
        }
        preset.name = name;
        Ok(StateDiff {
            power: None,
            params: None, // a rename never touches the engine
            changed: true,
            minted_id: None,
        })
    }

    /// [`Command::RemoveEqPreset`]: drop a custom EQ preset; every
    /// profile selecting it falls back to `None` — its own EQ params,
    /// flushed iff one of them is the selected profile.
    fn remove_eq_preset(
        &mut self,
        id: &PresetId,
        defs: &[ParameterDef],
    ) -> Result<StateDiff, ValidationError> {
        let preset = self
            .eq_preset(id)
            .ok_or_else(|| ValidationError::UnknownEqPreset(id.0.clone()))?;
        if preset.is_factory {
            return Err(ValidationError::FactoryImmutable {
                kind: ItemKind::EqPreset,
                id: id.0.clone(),
            });
        }
        let live = self.selected().selected_eq_preset.as_ref() == Some(id);
        self.eq_presets.retain(|preset| preset.id != *id);
        for profile in &mut self.profiles {
            if profile.selected_eq_preset.as_ref() == Some(id) {
                profile.selected_eq_preset = None;
            }
        }
        Ok(StateDiff {
            power: None,
            // The fallback has landed: the batch is the profile's own.
            params: live.then(|| self.eq_batch(defs)),
            changed: true,
            minted_id: None,
        })
    }

    /// [`Command::SetEqPreset`]: store the selection, flush-iff-live.
    fn set_eq_preset(
        &mut self,
        profile_id: ProfileId,
        id: Option<PresetId>,
        defs: &[ParameterDef],
    ) -> Result<StateDiff, ValidationError> {
        if let Some(preset_id) = &id
            && self.eq_preset(preset_id).is_none()
        {
            return Err(ValidationError::UnknownEqPreset(preset_id.0.clone()));
        }
        let live = self.selected_profile == profile_id;
        let profile = self
            .profile_mut(&profile_id)
            .ok_or(ValidationError::UnknownProfile(profile_id.0))?;
        if profile.selected_eq_preset == id {
            return Ok(StateDiff::default());
        }
        profile.selected_eq_preset = id;
        Ok(StateDiff {
            power: None,
            // Live ⇒ the targeted profile is the selected one.
            params: live.then(|| self.eq_batch(defs)),
            changed: true,
            minted_id: None,
        })
    }

    /// [`Command::EditEqPreset`]: merge into the global preset; flush
    /// iff the selected profile selects it.
    fn edit_eq_preset(
        &mut self,
        id: PresetId,
        params: &HashMap<String, Vec<i16>>,
        defs: &[ParameterDef],
    ) -> Result<StateDiff, ValidationError> {
        // Validate everything before mutating anything.
        for (name, values) in params {
            validate_eq_preset_write(defs, name, values)?;
        }
        let live = self.selected().selected_eq_preset.as_ref() == Some(&id);
        let preset = self
            .eq_preset_mut(&id)
            .ok_or(ValidationError::UnknownEqPreset(id.0))?;
        let mut batch = Vec::with_capacity(params.len());
        let mut changed = false;
        for def in defs {
            let Some(values) = params.get(&def.name) else {
                continue;
            };
            if preset.params[&def.name][..values.len()] != values[..] {
                preset.splice(&def.name, values);
                changed = true;
            }
            batch.push((def.name.clone(), values.clone()));
        }
        Ok(StateDiff {
            power: None,
            params: (changed && live).then_some(batch),
            changed,
            minted_id: None,
        })
    }

    /// [`Command::ResetEqPreset`]: restore the baseline; flush iff the
    /// selected profile selects the preset.
    fn reset_eq_preset(
        &mut self,
        id: PresetId,
        defs: &[ParameterDef],
    ) -> Result<StateDiff, ValidationError> {
        let live = self.selected().selected_eq_preset.as_ref() == Some(&id);
        let preset = self
            .eq_preset_mut(&id)
            .ok_or_else(|| ValidationError::UnknownEqPreset(id.0.clone()))?;
        if !preset.is_factory {
            return Err(ValidationError::ResetCustom {
                kind: ItemKind::EqPreset,
                id: id.0,
            });
        }
        if preset.params == preset.baseline {
            return Ok(StateDiff::default());
        }
        preset.params = preset.baseline.clone();
        Ok(StateDiff {
            power: None,
            params: live.then(|| self.eq_batch(defs)),
            changed: true,
            minted_id: None,
        })
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
    /// Selects one profile's EQ preset overlay — or detaches it.
    /// Flushes to the engine only when that profile is selected.
    SetEqPreset {
        /// The profile whose selection changes (explicit target — EQ
        /// selection is per-profile, unlike the global
        /// [`Command::SetProfile`]).
        profile_id: ProfileId,
        /// The preset to select; `None` ⇒ the profile's own EQ params
        /// apply ("Off" is `None`, not a preset).
        id: Option<PresetId>,
    },
    /// Writes a param map into one EQ preset (preset-carried params only).
    ///
    /// Flushes to the engine only when the selected profile selects
    /// that preset — and, presets being global, is visible to every
    /// profile selecting it.
    EditEqPreset {
        /// The preset to edit.
        id: PresetId,
        /// The edited entries, keyed by 4-CC.
        params: HashMap<String, Vec<i16>>,
    },
    /// Drops an EQ preset's own overrides, restoring its baseline.
    ResetEqPreset {
        /// The preset to reset.
        id: PresetId,
    },
    /// Clones one profile — resolved params and EQ preset selection, so
    /// the clone sounds identical — into a new custom profile under a
    /// freshly minted id, reported as [`StateDiff::minted_id`].
    AddProfile {
        /// The profile to clone.
        from: ProfileId,
        /// The new profile's display name.
        name: String,
    },
    /// Renames a custom profile (factory names are immutable); the id —
    /// what persistence keys on — never changes.
    RenameProfile {
        /// The profile to rename.
        id: ProfileId,
        /// The new display name.
        name: String,
    },
    /// Removes a custom profile (factory profiles are permanent). When
    /// it was selected, the selection falls back to
    /// [`State::fallback_profile`] and the engine gets that profile's
    /// full resolved set.
    RemoveProfile {
        /// The profile to remove.
        id: ProfileId,
    },
    /// Clones one EQ preset into a new custom preset under a freshly
    /// minted id, reported as [`StateDiff::minted_id`].
    AddEqPreset {
        /// The preset to clone.
        from: PresetId,
        /// The new preset's display name.
        name: String,
    },
    /// Renames a custom EQ preset (factory names are immutable); the id
    /// never changes.
    RenameEqPreset {
        /// The preset to rename.
        id: PresetId,
        /// The new display name.
        name: String,
    },
    /// Removes a custom EQ preset (factory presets are permanent).
    /// Every profile selecting it falls back to `None` — its own EQ
    /// params, flushed iff one of them is the selected profile.
    RemoveEqPreset {
        /// The preset to remove.
        id: PresetId,
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
    /// profile switch or reset carries the full resolved set, an EQ
    /// preset switch/detach/reset the resolved preset-carried set, a
    /// live edit the edited entries (a single control edit is a
    /// 1-entry batch — never a dribble).
    pub params: Option<Vec<(String, Vec<i16>)>>,
    /// Whether any persistent state changed (⇒ flush + broadcast even
    /// when the engine hears nothing, e.g. an edit to a non-selected
    /// profile).
    pub changed: bool,
    /// The server-minted `user_<hash>` id of the item an `add_*`
    /// created — returned on the originator's ack so it applies locally
    /// without waiting for a snapshot (ADR-0005).
    pub minted_id: Option<String>,
}

impl StateDiff {
    /// `true` when the command changed nothing.
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        !self.changed
    }
}

/// Which item family a [`ValidationError`] names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItemKind {
    /// A profile.
    Profile,
    /// An EQ preset.
    EqPreset,
}

impl std::fmt::Display for ItemKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Profile => "profile",
            Self::EqPreset => "EQ preset",
        })
    }
}

/// A semantically invalid command — surfaced on the wire as
/// `INVALID_REQUEST`, with the state left untouched.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ValidationError {
    /// The profile id names no profile.
    #[error("unknown profile `{0}`")]
    UnknownProfile(String),
    /// The preset id names no EQ preset.
    #[error("unknown EQ preset `{0}`")]
    UnknownEqPreset(String),
    /// The parameter is not preset-carried — EQ presets own exactly the
    /// `category ∈ {Ieq, Geq}` params (ADR-0003).
    #[error("parameter `{0}` is not preset-carried (not an IEQ/GEQ param)")]
    NotPresetCarried(String),
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
    /// The id names a factory item (present in `defaults.toml`) —
    /// factory items reset instead of rename/remove.
    #[error("factory {kind} `{id}` cannot be renamed or removed")]
    FactoryImmutable {
        /// The item family.
        kind: ItemKind,
        /// The factory id.
        id: String,
    },
    /// The id names a custom item — reset is factory-only: a custom
    /// item has no layer beneath its overrides, so resetting it would
    /// mean removing it.
    #[error("custom {kind} `{id}` cannot be reset — remove it instead")]
    ResetCustom {
        /// The item family.
        kind: ItemKind,
        /// The custom id.
        id: String,
    },
    /// An `add_*`/`rename_*` display name is empty after trimming.
    #[error("name must not be empty")]
    EmptyName,
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

/// Validates and normalizes an `add_*`/`rename_*` display name:
/// trimmed, non-empty.
fn valid_name(name: &str) -> Result<String, ValidationError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(ValidationError::EmptyName);
    }
    Ok(name.to_string())
}

/// Mints a fresh custom-item id — `user_` plus four hex digits: an
/// FNV-1a hash of the display name, probed upward through the 16-bit
/// space until an id nothing in `taken` holds. Deterministic and
/// I/O-free (`ddp-state` stays pure); uniqueness is per namespace.
///
/// # Panics
///
/// Never in practice: only with all 65 536 custom ids taken.
fn mint_id(name: &str, taken: impl Fn(&str) -> bool) -> String {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in name.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    let seed = hash ^ (hash >> 16) ^ (hash >> 32) ^ (hash >> 48);
    let seed = u16::try_from(seed & 0xffff).expect("masked to 16 bits");
    (0..=u16::MAX)
        .map(|probe| format!("user_{:04x}", seed.wrapping_add(probe)))
        .find(|id| !taken(id))
        .expect("all 65 536 custom ids taken")
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

/// [`validate_write`] plus preset eligibility: EQ presets carry exactly
/// the preset-carried params (`category ∈ {Ieq, Geq}` — derived, never
/// declared; ADR-0003).
///
/// # Errors
///
/// The first violated rule, as a [`ValidationError`].
pub fn validate_eq_preset_write(
    defs: &[ParameterDef],
    name: &str,
    values: &[i16],
) -> Result<(), ValidationError> {
    validate_write(defs, name, values)?;
    if lookup(defs, name).is_some_and(|def| !def.category.is_preset_carried()) {
        return Err(ValidationError::NotPresetCarried(name.into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::param_def::{ParamAccess, ParamCategory, ParamKind, base_eq_params, base_params};

    /// A compact stand-in for the 64-entry table: a leveler scalar, the
    /// IEQ/GEQ preset-carried families (band allocation 4, like the
    /// real 40), one experimental, one read-only.
    fn defs() -> Vec<ParameterDef> {
        let def =
            |name: &str, length: usize, min: i16, max: i16, default: Vec<i16>, category, access| {
                ParameterDef {
                    name: name.into(),
                    length,
                    min,
                    max,
                    frac_bits: 0,
                    default,
                    kind: ParamKind::Integer,
                    category,
                    access,
                    label: name.to_uppercase(),
                    description: String::new(),
                    help: String::new(),
                }
            };
        vec![
            def(
                "dvla",
                1,
                0,
                10,
                vec![7],
                ParamCategory::VolumeLeveller,
                ParamAccess::Settable,
            ),
            def(
                "iebt",
                4,
                -480,
                480,
                vec![0; 4],
                ParamCategory::Ieq,
                ParamAccess::Settable,
            ),
            def(
                "ieon",
                1,
                0,
                1,
                vec![0],
                ParamCategory::Ieq,
                ParamAccess::Settable,
            ),
            def(
                "genb",
                1,
                1,
                4,
                vec![2],
                ParamCategory::Geq,
                ParamAccess::Settable,
            ),
            def(
                "gebg",
                4,
                -576,
                576,
                vec![0; 4],
                ParamCategory::Geq,
                ParamAccess::Settable,
            ),
            def(
                "ven",
                1,
                0,
                1,
                vec![0],
                ParamCategory::Visualizer,
                ParamAccess::Experimental,
            ),
            def(
                "vnnb",
                1,
                1,
                20,
                vec![20],
                ParamCategory::Visualizer,
                ParamAccess::ReadOnlyStatic,
            ),
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

    fn preset(id: &str, name: &str, iebt: &[i16], table: &[ParameterDef]) -> EqPreset {
        let mut params = base_eq_params(table);
        params.insert("ieon".into(), vec![1]);
        params.insert("iebt".into(), iebt.to_vec());
        EqPreset {
            id: PresetId(id.into()),
            name: name.into(),
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
            eq_presets: vec![
                preset("open", "Open", &[117, 133, -27, -240], &table),
                preset("rich", "Rich", &[67, 95, -55, -235], &table),
            ],
            custom_profile_baseline: base_params(&table),
            custom_eq_preset_baseline: base_eq_params(&table),
        }
    }

    fn rich() -> PresetId {
        PresetId("rich".into())
    }

    fn select_preset(profile_id: &str, id: Option<PresetId>) -> Command {
        Command::SetEqPreset {
            profile_id: ProfileId(profile_id.into()),
            id,
        }
    }

    /// Behavior 2 (issue #18): a fresh install runs the factory state —
    /// `music` selected, profiles complete; the factory EQ presets ride
    /// along with no profile selecting one (behavior 7, issue #23).
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
        assert_eq!(state.eq_presets.len(), 2);
        let rich = state.eq_preset(&PresetId("rich".into())).expect("rich");
        assert_eq!(rich.name, "Rich");
        assert!(rich.is_factory);
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
                ("iebt".to_string(), vec![0; 4]),
                ("ieon".to_string(), vec![0]),
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

    /// Behavior 2 (issue #23), state half: selecting a preset stores
    /// the selection on that profile and batches the resolved
    /// preset-carried set — the preset's params shadow the profile's
    /// own *entirely* (a diverging own `gebg` must not leak through).
    #[test]
    fn set_eq_preset_selects_and_batches_the_presets_resolved_eq_set() {
        let mut state = State::new_from_defaults(&defaults());
        let _ = state
            .apply(edit("music", &[("gebg", &[5, -5])]), &defs())
            .unwrap();

        let diff = state
            .apply(select_preset("music", Some(rich())), &defs())
            .unwrap();
        assert_eq!(state.selected().selected_eq_preset, Some(rich()));
        assert_eq!(
            diff.params.unwrap(),
            vec![
                ("iebt".to_string(), vec![67_i16, 95, -55, -235]),
                ("ieon".to_string(), vec![1]),
                ("genb".to_string(), vec![2]),
                ("gebg".to_string(), vec![0; 4]), // the preset's, not music's [5, -5]
            ],
            "the full preset-carried set in table order — never a half-apply"
        );
        assert_eq!(
            state.selected().params["gebg"],
            vec![5, -5, 0, 0],
            "the profile's own EQ params survive underneath"
        );
    }

    /// Behavior 3 (issue #23), state half: `id: None` detaches — the
    /// batch carries the profile's own EQ params again.
    #[test]
    fn set_eq_preset_none_detaches_and_batches_the_profiles_own_eq() {
        let mut state = State::new_from_defaults(&defaults());
        let _ = state
            .apply(edit("music", &[("gebg", &[5, -5])]), &defs())
            .unwrap();
        let _ = state
            .apply(select_preset("music", Some(rich())), &defs())
            .unwrap();

        let diff = state.apply(select_preset("music", None), &defs()).unwrap();
        assert_eq!(state.selected().selected_eq_preset, None);
        assert_eq!(
            diff.params.unwrap(),
            vec![
                ("iebt".to_string(), vec![0_i16; 4]),
                ("ieon".to_string(), vec![0]),
                ("genb".to_string(), vec![2]),
                ("gebg".to_string(), vec![5, -5, 0, 0]),
            ],
        );
    }

    /// Behavior 5 (issue #23), state half: a selection on a
    /// non-selected profile persists without a batch; re-selecting the
    /// current preset is a no-op; unknown ids are rejected unchanged.
    #[test]
    fn set_eq_preset_flushes_iff_live_and_validates_ids() {
        let mut state = State::new_from_defaults(&defaults());
        let diff = state
            .apply(select_preset("movie", Some(rich())), &defs())
            .unwrap();
        assert!(!diff.is_empty(), "the change must flush + broadcast");
        assert_eq!(diff.params, None, "…but the engine hears nothing");
        assert_eq!(
            state
                .profile(&ProfileId("movie".into()))
                .unwrap()
                .selected_eq_preset,
            Some(rich())
        );

        let diff = state
            .apply(select_preset("movie", Some(rich())), &defs())
            .unwrap();
        assert!(diff.is_empty(), "re-selecting the current preset");
        let diff = state.apply(select_preset("music", None), &defs()).unwrap();
        assert!(diff.is_empty(), "detaching an already-detached profile");

        let before = state.clone();
        assert_eq!(
            state.apply(select_preset("ghost", Some(rich())), &defs()),
            Err(ValidationError::UnknownProfile("ghost".into())),
        );
        assert_eq!(
            state.apply(
                select_preset("music", Some(PresetId("ghost".into()))),
                &defs()
            ),
            Err(ValidationError::UnknownEqPreset("ghost".into())),
        );
        assert_eq!(state, before, "rejected commands must not mutate");
    }

    /// Behavior 4 (issue #23), state half: `edit_eq_preset` merges into
    /// the global preset — visible to every selecting profile — and
    /// batches iff the *selected* profile selects it.
    #[test]
    fn edit_eq_preset_flushes_iff_the_selected_profile_selects_it() {
        let mut state = State::new_from_defaults(&defaults());
        let _ = state
            .apply(select_preset("movie", Some(rich())), &defs())
            .unwrap();

        // Selected profile (music) doesn't select rich: persist only.
        let edit_rich = |values: &'static [i16]| Command::EditEqPreset {
            id: PresetId("rich".into()),
            params: [("iebt".to_string(), values.to_vec())].into(),
        };
        let diff = state.apply(edit_rich(&[100]), &defs()).unwrap();
        assert!(!diff.is_empty());
        assert_eq!(diff.params, None, "no selecting active profile");

        // Music selects rich too: now the same edit flushes, and the
        // earlier one is already visible (one global preset).
        let _ = state
            .apply(select_preset("music", Some(rich())), &defs())
            .unwrap();
        let preset = state.eq_preset(&PresetId("rich".into())).unwrap();
        assert_eq!(preset.params["iebt"], vec![100, 95, -55, -235]);

        let diff = state.apply(edit_rich(&[42, 43]), &defs()).unwrap();
        assert_eq!(
            diff.params.unwrap(),
            vec![("iebt".to_string(), vec![42, 43])],
            "live edit batches exactly the edited entries"
        );
        let preset = state.eq_preset(&PresetId("rich".into())).unwrap();
        assert_eq!(preset.params["iebt"], vec![42, 43, -55, -235]);
        assert_eq!(
            preset.baseline["iebt"],
            vec![67, 95, -55, -235],
            "baseline untouched"
        );

        // Writing the current values is a no-op.
        let diff = state.apply(edit_rich(&[42, 43]), &defs()).unwrap();
        assert!(diff.is_empty());
    }

    /// EQ preset validation: unknown preset, non-preset-carried and
    /// read-only params, shape/range violations — all rejected with
    /// state untouched.
    #[test]
    fn edit_eq_preset_validation_rejects_bad_entries_unchanged() {
        let mut state = State::new_from_defaults(&defaults());
        let before = state.clone();
        let edit = |id: &str, name: &str, values: &[i16]| Command::EditEqPreset {
            id: PresetId(id.into()),
            params: [(name.to_string(), values.to_vec())].into(),
        };
        let rejected = [
            (
                edit("ghost", "iebt", &[1]),
                ValidationError::UnknownEqPreset("ghost".into()),
            ),
            (
                edit("rich", "dvla", &[4]),
                ValidationError::NotPresetCarried("dvla".into()),
            ),
            (
                edit("rich", "vnnb", &[10]),
                ValidationError::ReadOnlyParam("vnnb".into()),
            ),
            (
                edit("rich", "iebt", &[481]),
                ValidationError::OutOfRange {
                    name: "iebt".into(),
                    index: 0,
                    value: 481,
                    min: -480,
                    max: 480,
                },
            ),
        ];
        for (command, expected) in rejected {
            assert_eq!(state.apply(command, &defs()), Err(expected));
            assert_eq!(state, before, "a rejected edit must not mutate");
        }
        assert_eq!(
            ValidationError::NotPresetCarried("dvla".into()).to_string(),
            "parameter `dvla` is not preset-carried (not an IEQ/GEQ param)"
        );
    }

    /// The overlay rule end to end (ADR-0003): with a preset selected,
    /// the full resolved batch carries the preset's EQ params, and a
    /// live `edit_profile` of shadowed EQ params persists without the
    /// engine hearing the shadowed values.
    #[test]
    fn a_selected_preset_shadows_the_profiles_eq_params_entirely() {
        let mut state = State::new_from_defaults(&defaults());
        let _ = state
            .apply(select_preset("music", Some(rich())), &defs())
            .unwrap();

        let batch = state.resolved_batch(&defs());
        assert_eq!(
            batch,
            vec![
                ("dvla".to_string(), vec![4_i16]),             // the profile's own
                ("iebt".to_string(), vec![67, 95, -55, -235]), // the preset's
                ("ieon".to_string(), vec![1]),
                ("genb".to_string(), vec![2]),
                ("gebg".to_string(), vec![0; 4]),
                ("ven".to_string(), vec![0]),
            ],
        );

        // A live edit of a shadowed param: persisted, engine silent.
        let diff = state
            .apply(edit("music", &[("gebg", &[9])]), &defs())
            .unwrap();
        assert!(!diff.is_empty(), "the profile's own value changed");
        assert_eq!(diff.params, None, "…shadowed ⇒ no engine batch");
        assert_eq!(state.selected().params["gebg"], vec![9, 0, 0, 0]);

        // A mixed edit batches only the effective (non-shadowed) half.
        let diff = state
            .apply(edit("music", &[("dvla", &[9]), ("gebg", &[7])]), &defs())
            .unwrap();
        assert_eq!(
            diff.params.unwrap(),
            vec![("dvla".to_string(), vec![9_i16])],
        );
    }

    /// Behavior 2 (issue #26): `add_profile` clones the source's
    /// resolved params — and its EQ preset selection, so the clone
    /// sounds identical — under a freshly minted `user_<hash>` id
    /// reported on the diff. The clone's divergence base is the custom
    /// baseline (no `defaults.toml` row beneath it), and the engine
    /// hears nothing (the clone is not selected).
    #[test]
    fn add_profile_clones_the_source_under_a_minted_id() {
        let mut state = State::new_from_defaults(&defaults());
        let _ = state
            .apply(select_preset("music", Some(rich())), &defs())
            .unwrap();

        let diff = state
            .apply(
                Command::AddProfile {
                    from: ProfileId("music".into()),
                    name: "Late Night".into(),
                },
                &defs(),
            )
            .unwrap();
        let id = diff.minted_id.expect("add mints an id");
        assert!(
            id.starts_with("user_") && id.len() == 9,
            "`user_<hash>`, got {id}"
        );
        assert!(id[5..].chars().all(|c| c.is_ascii_hexdigit()));
        assert!(diff.changed);
        assert_eq!(diff.params, None, "not selected ⇒ the engine is silent");

        let clone = state.profile(&ProfileId(id)).expect("the clone exists");
        assert_eq!(clone.name, "Late Night");
        assert!(!clone.is_factory);
        assert_eq!(clone.selected_eq_preset, Some(rich()), "selection cloned");
        assert_eq!(clone.params["dvla"], vec![4], "music's override cloned");
        assert_eq!(
            clone.baseline["dvla"],
            vec![7],
            "…as a divergence over the custom baseline, not baked in"
        );
        assert_eq!(
            state.selected_profile,
            ProfileId("music".into()),
            "adding never moves the selection"
        );
    }

    /// Behavior 2's preset half (issue #26): `add_eq_preset` clones the
    /// source preset under a minted id; two adds with one name still
    /// mint distinct ids (the hash probes past a collision); no
    /// selection moves, so the engine is silent.
    #[test]
    fn add_eq_preset_clones_under_distinct_minted_ids() {
        let mut state = State::new_from_defaults(&defaults());
        let add = Command::AddEqPreset {
            from: PresetId("rich".into()),
            name: "Vocal".into(),
        };
        let first = state.apply(add.clone(), &defs()).unwrap();
        let second = state.apply(add, &defs()).unwrap();
        let first = first.minted_id.expect("add mints an id");
        let second = second.minted_id.expect("add mints an id");
        assert_ne!(first, second, "one name, distinct ids");

        let clone = state.eq_preset(&PresetId(first)).expect("the clone exists");
        assert_eq!(clone.name, "Vocal");
        assert!(!clone.is_factory);
        assert_eq!(
            clone.params["iebt"],
            vec![67, 95, -55, -235],
            "rich's curve"
        );
        assert_eq!(
            clone.baseline["iebt"],
            vec![0; 4],
            "the custom baseline sits beneath the cloned divergence"
        );
        assert_eq!(state.eq_presets.len(), 4);
    }

    /// `add_*` validation: unknown sources and empty (or all-blank)
    /// names are rejected with the state untouched; names store
    /// trimmed.
    #[test]
    fn add_validation_rejects_unknown_sources_and_empty_names() {
        let mut state = State::new_from_defaults(&defaults());
        let before = state.clone();
        let rejected = [
            (
                Command::AddProfile {
                    from: ProfileId("ghost".into()),
                    name: "X".into(),
                },
                ValidationError::UnknownProfile("ghost".into()),
            ),
            (
                Command::AddEqPreset {
                    from: PresetId("ghost".into()),
                    name: "X".into(),
                },
                ValidationError::UnknownEqPreset("ghost".into()),
            ),
            (
                Command::AddProfile {
                    from: ProfileId("music".into()),
                    name: "  ".into(),
                },
                ValidationError::EmptyName,
            ),
            (
                Command::AddEqPreset {
                    from: PresetId("rich".into()),
                    name: String::new(),
                },
                ValidationError::EmptyName,
            ),
        ];
        for (command, expected) in rejected {
            assert_eq!(state.apply(command, &defs()), Err(expected));
            assert_eq!(state, before, "a rejected add must not mutate");
        }
        assert_eq!(
            ValidationError::EmptyName.to_string(),
            "name must not be empty"
        );

        let diff = state
            .apply(
                Command::AddProfile {
                    from: ProfileId("music".into()),
                    name: "  Padded  ".into(),
                },
                &defs(),
            )
            .unwrap();
        let id = ProfileId(diff.minted_id.expect("minted"));
        assert_eq!(state.profile(&id).unwrap().name, "Padded", "stored trimmed");
    }

    /// Behavior 3 (issue #26): rename updates the display name only —
    /// the id (what persistence keys on) never moves — and renaming to
    /// the current name is a no-op.
    #[test]
    fn rename_updates_the_name_with_the_id_stable() {
        let mut state = State::new_from_defaults(&defaults());
        let added = state
            .apply(
                Command::AddProfile {
                    from: ProfileId("music".into()),
                    name: "Loud".into(),
                },
                &defs(),
            )
            .unwrap();
        let id = ProfileId(added.minted_id.expect("minted"));

        let diff = state
            .apply(
                Command::RenameProfile {
                    id: id.clone(),
                    name: "Late Night".into(),
                },
                &defs(),
            )
            .unwrap();
        assert!(diff.changed);
        assert_eq!(diff.params, None, "a rename never touches the engine");
        assert_eq!(state.profile(&id).unwrap().name, "Late Night");

        let diff = state
            .apply(
                Command::RenameProfile {
                    id: id.clone(),
                    name: "Late Night".into(),
                },
                &defs(),
            )
            .unwrap();
        assert!(diff.is_empty(), "renaming to the current name");

        let added = state
            .apply(
                Command::AddEqPreset {
                    from: rich(),
                    name: "Vocal".into(),
                },
                &defs(),
            )
            .unwrap();
        let preset_id = PresetId(added.minted_id.expect("minted"));
        let diff = state
            .apply(
                Command::RenameEqPreset {
                    id: preset_id.clone(),
                    name: "Vocal Forward".into(),
                },
                &defs(),
            )
            .unwrap();
        assert!(diff.changed);
        assert_eq!(state.eq_preset(&preset_id).unwrap().name, "Vocal Forward");
    }

    /// Behavior 4 (issue #26): factory items can be neither renamed nor
    /// removed — `INVALID_REQUEST` with the state untouched; unknown
    /// ids reject as everywhere else.
    #[test]
    fn factory_items_cannot_be_renamed_or_removed() {
        let mut state = State::new_from_defaults(&defaults());
        let before = state.clone();
        let factory_profile = ValidationError::FactoryImmutable {
            kind: ItemKind::Profile,
            id: "music".into(),
        };
        let factory_preset = ValidationError::FactoryImmutable {
            kind: ItemKind::EqPreset,
            id: "rich".into(),
        };
        let rejected = [
            (
                Command::RenameProfile {
                    id: ProfileId("music".into()),
                    name: "Loud".into(),
                },
                factory_profile.clone(),
            ),
            (
                Command::RemoveProfile {
                    id: ProfileId("music".into()),
                },
                factory_profile.clone(),
            ),
            (
                Command::RenameEqPreset {
                    id: rich(),
                    name: "Loud".into(),
                },
                factory_preset.clone(),
            ),
            (Command::RemoveEqPreset { id: rich() }, factory_preset),
            (
                Command::RenameProfile {
                    id: ProfileId("ghost".into()),
                    name: "X".into(),
                },
                ValidationError::UnknownProfile("ghost".into()),
            ),
            (
                Command::RemoveProfile {
                    id: ProfileId("ghost".into()),
                },
                ValidationError::UnknownProfile("ghost".into()),
            ),
            (
                Command::RenameEqPreset {
                    id: PresetId("ghost".into()),
                    name: "X".into(),
                },
                ValidationError::UnknownEqPreset("ghost".into()),
            ),
            (
                Command::RemoveEqPreset {
                    id: PresetId("ghost".into()),
                },
                ValidationError::UnknownEqPreset("ghost".into()),
            ),
        ];
        for (command, expected) in rejected {
            assert_eq!(state.apply(command, &defs()), Err(expected));
            assert_eq!(state, before, "a rejected command must not mutate");
        }
        assert_eq!(
            factory_profile.to_string(),
            "factory profile `music` cannot be renamed or removed"
        );
    }

    /// Behavior 5 (issue #26): removing a custom EQ preset selected by
    /// N profiles falls all N back to `None`; iff one of them is the
    /// selected profile, flush-iff-live pushes that profile's own EQ
    /// params.
    #[test]
    fn remove_eq_preset_falls_every_selector_back_to_none() {
        let mut state = State::new_from_defaults(&defaults());
        let added = state
            .apply(
                Command::AddEqPreset {
                    from: rich(),
                    name: "Vocal".into(),
                },
                &defs(),
            )
            .unwrap();
        let custom = PresetId(added.minted_id.expect("minted"));
        let _ = state
            .apply(select_preset("music", Some(custom.clone())), &defs())
            .unwrap();
        let _ = state
            .apply(select_preset("movie", Some(custom.clone())), &defs())
            .unwrap();
        // Give music's own GEQ a divergence so the fallback flush is
        // observably the profile's own, not the preset's.
        let _ = state
            .apply(edit("music", &[("gebg", &[5, -5])]), &defs())
            .unwrap();

        let diff = state
            .apply(Command::RemoveEqPreset { id: custom.clone() }, &defs())
            .unwrap();
        assert!(diff.changed);
        assert_eq!(
            diff.params.expect("the selected profile selected it"),
            vec![
                ("iebt".to_string(), vec![0_i16; 4]),
                ("ieon".to_string(), vec![0]),
                ("genb".to_string(), vec![2]),
                ("gebg".to_string(), vec![5, -5, 0, 0]),
            ],
            "the profile's own EQ params — no Off preset"
        );
        assert_eq!(state.eq_preset(&custom), None, "the preset is gone");
        assert!(
            state
                .profiles
                .iter()
                .all(|profile| profile.selected_eq_preset.is_none()),
            "every selector fell back to None"
        );

        // Selected only by a non-selected profile: state changes, the
        // engine hears nothing.
        let added = state
            .apply(
                Command::AddEqPreset {
                    from: rich(),
                    name: "Offline".into(),
                },
                &defs(),
            )
            .unwrap();
        let custom = PresetId(added.minted_id.expect("minted"));
        let _ = state
            .apply(select_preset("movie", Some(custom.clone())), &defs())
            .unwrap();
        let diff = state
            .apply(Command::RemoveEqPreset { id: custom }, &defs())
            .unwrap();
        assert!(diff.changed);
        assert_eq!(diff.params, None, "no selecting active profile");
    }

    /// Behavior 6 (issue #26): removing the selected custom profile
    /// falls the selection back to `defaults.toml`'s
    /// `selected_profile`, the engine getting that profile's full
    /// resolved set; removing a non-selected one is engine-silent.
    #[test]
    fn remove_selected_profile_falls_back_to_the_factory_selection() {
        let mut state = State::new_from_defaults(&defaults());
        let added = state
            .apply(
                Command::AddProfile {
                    from: ProfileId("movie".into()),
                    name: "Mine".into(),
                },
                &defs(),
            )
            .unwrap();
        let id = ProfileId(added.minted_id.expect("minted"));
        let _ = state
            .apply(Command::SetProfile { id: id.clone() }, &defs())
            .unwrap();

        let diff = state
            .apply(Command::RemoveProfile { id: id.clone() }, &defs())
            .unwrap();
        assert_eq!(
            state.selected_profile,
            ProfileId("music".into()),
            "the fallback is the factory selection"
        );
        assert_eq!(state.profile(&id), None, "the profile is gone");
        let batch = diff.params.expect("the selection moved — full set");
        assert!(
            batch.contains(&("dvla".to_string(), vec![4])),
            "music's resolved values, not the removed clone's [7]"
        );

        // Non-selected removal: state changes, the engine is silent.
        let added = state
            .apply(
                Command::AddProfile {
                    from: ProfileId("music".into()),
                    name: "Other".into(),
                },
                &defs(),
            )
            .unwrap();
        let diff = state
            .apply(
                Command::RemoveProfile {
                    id: ProfileId(added.minted_id.expect("minted")),
                },
                &defs(),
            )
            .unwrap();
        assert!(diff.changed);
        assert_eq!(diff.params, None);
    }

    /// Behavior 7 (issue #26), the custom half: reset stays
    /// factory-only — a custom item has no layer beneath its overrides
    /// (resetting it would mean removing it) — `INVALID_REQUEST` with
    /// the state untouched.
    #[test]
    fn reset_rejects_custom_items() {
        let mut state = State::new_from_defaults(&defaults());
        let profile_id = state
            .apply(
                Command::AddProfile {
                    from: ProfileId("music".into()),
                    name: "Mine".into(),
                },
                &defs(),
            )
            .unwrap()
            .minted_id
            .expect("minted");
        let preset_id = state
            .apply(
                Command::AddEqPreset {
                    from: rich(),
                    name: "Vocal".into(),
                },
                &defs(),
            )
            .unwrap()
            .minted_id
            .expect("minted");
        let before = state.clone();

        let error = ValidationError::ResetCustom {
            kind: ItemKind::Profile,
            id: profile_id.clone(),
        };
        assert_eq!(
            state.apply(
                Command::ResetProfile {
                    id: ProfileId(profile_id.clone()),
                },
                &defs(),
            ),
            Err(error.clone()),
        );
        assert_eq!(
            error.to_string(),
            format!("custom profile `{profile_id}` cannot be reset — remove it instead"),
        );
        assert_eq!(
            state.apply(
                Command::ResetEqPreset {
                    id: PresetId(preset_id.clone()),
                },
                &defs(),
            ),
            Err(ValidationError::ResetCustom {
                kind: ItemKind::EqPreset,
                id: preset_id,
            }),
        );
        assert_eq!(state, before, "a rejected reset must not mutate");
    }

    /// Behavior 7 (issue #26), the selection half: a factory profile's
    /// EQ preset selection is a `config.toml` override like any other —
    /// reset clears it back to the factory `None`, the live flush
    /// carrying the profile's own EQ params again.
    #[test]
    fn reset_profile_clears_the_eq_preset_selection() {
        let mut state = State::new_from_defaults(&defaults());
        let _ = state
            .apply(select_preset("music", Some(rich())), &defs())
            .unwrap();

        let diff = state
            .apply(
                Command::ResetProfile {
                    id: ProfileId("music".into()),
                },
                &defs(),
            )
            .unwrap();
        assert!(diff.changed, "the selection was an override");
        assert_eq!(state.selected().selected_eq_preset, None);
        let batch = diff.params.expect("live reset flushes the full set");
        assert!(
            batch.contains(&("ieon".to_string(), vec![0])),
            "the profile's own EQ params, not rich's"
        );

        let diff = state
            .apply(
                Command::ResetProfile {
                    id: ProfileId("music".into()),
                },
                &defs(),
            )
            .unwrap();
        assert!(diff.is_empty(), "nothing diverging ⇒ a reset is a no-op");
    }

    /// `reset_eq_preset` restores the baseline and batches iff the
    /// selected profile selects the preset.
    #[test]
    fn reset_eq_preset_restores_the_baseline_and_batches_when_live() {
        let mut state = State::new_from_defaults(&defaults());
        let rich_id = PresetId("rich".into());
        let edit_rich = Command::EditEqPreset {
            id: rich_id.clone(),
            params: [("iebt".to_string(), vec![100_i16])].into(),
        };
        let reset_rich = Command::ResetEqPreset {
            id: rich_id.clone(),
        };

        // Not selected anywhere: reset persists, engine silent.
        let _ = state.apply(edit_rich.clone(), &defs()).unwrap();
        let diff = state.apply(reset_rich.clone(), &defs()).unwrap();
        assert!(!diff.is_empty());
        assert_eq!(diff.params, None);
        assert_eq!(
            state.eq_preset(&rich_id).unwrap().params["iebt"],
            vec![67, 95, -55, -235],
            "factory curve restored"
        );

        // Nothing diverging ⇒ a reset is a no-op.
        let diff = state.apply(reset_rich.clone(), &defs()).unwrap();
        assert!(diff.is_empty());

        // Selected by the active profile: the restored set flushes.
        let _ = state
            .apply(select_preset("music", Some(rich())), &defs())
            .unwrap();
        let _ = state.apply(edit_rich, &defs()).unwrap();
        let diff = state.apply(reset_rich, &defs()).unwrap();
        assert_eq!(
            diff.params.unwrap(),
            vec![
                ("iebt".to_string(), vec![67_i16, 95, -55, -235]),
                ("ieon".to_string(), vec![1]),
                ("genb".to_string(), vec![2]),
                ("gebg".to_string(), vec![0; 4]),
            ],
            "a live reset flushes the preset's full resolved set"
        );

        assert_eq!(
            state.apply(
                Command::ResetEqPreset {
                    id: PresetId("ghost".into()),
                },
                &defs(),
            ),
            Err(ValidationError::UnknownEqPreset("ghost".into())),
        );
    }
}
