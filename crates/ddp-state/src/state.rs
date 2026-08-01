//! `State` — the daemon's user-facing state: power, factory profiles,
//! the selected profile, and the global EQ presets.
//!
//! Pure data + transitions, no I/O: [`State::apply`] is the single
//! mutation path, returning a [`StateDiff`] the daemon fans out to the
//! engine, persistence, and the WS broadcast.

use std::collections::HashMap;

use crate::param_def::{ParameterDef, lookup, splice_head};
use crate::preset::{EqPreset, PresetContent, PresetId};
use crate::profile::{Profile, ProfileContent, ProfileId};

/// The factory truth `defaults.toml` resolves to at startup: root keys
/// plus the factory profiles and EQ presets, each complete over
/// `ParameterDef.default`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Defaults {
    /// Factory master power.
    pub power: bool,
    /// Factory LAN access — ships `false` (ADR-0012).
    pub lan_access: bool,
    /// Factory selected profile.
    pub selected_profile: ProfileId,
    /// Factory profiles in declaration order, `content` fully resolved
    /// (`ParameterDef.default` ⊕ shared ⊕ item), `baseline == content`.
    pub profiles: Vec<Profile>,
    /// Factory EQ presets in declaration order, resolved the same way
    /// over the preset-carried params.
    pub eq_presets: Vec<EqPreset>,
    /// What a custom profile resolves to beneath any `config.toml`
    /// layer: `ParameterDef.default` ⊕ the `[profile]` shared layer —
    /// the factory half of the custom baseline (ADR-0007). Its EQ
    /// selection is `None` by construction: customs have no
    /// `defaults.toml` row and the shared tables stay params-only.
    pub custom_profile_baseline: ProfileContent,
    /// The EQ-preset counterpart, over the preset-carried params.
    pub custom_eq_preset_baseline: PresetContent,
}

/// The daemon's user-facing state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct State {
    /// Master power — `false` ⇒ every session is bypassed
    /// (`EFFECT_CMD_DISABLE`; parameter state survives the toggle).
    pub power: bool,
    /// LAN access — whether other devices on the local network may
    /// reach the daemon (ADR-0012). A root scalar like `power`; pure
    /// state here — the daemon owns the listener it drives.
    pub lan_access: bool,
    /// The one active profile, applied to all sessions. Invariant: it
    /// always names an entry of `profiles`.
    pub selected_profile: ProfileId,
    /// Every profile, factory first, customs in creation order.
    /// Invariant: every `Some` `selected_eq_preset` names an entry of
    /// `eq_presets` (load rejects a dangling EQ selection; the
    /// `EditProfile` EQ selection patch validates; `RemoveEqPreset`
    /// falls selecting profiles to `None`).
    pub profiles: Vec<Profile>,
    /// Every EQ preset, factory first — global across profiles.
    pub eq_presets: Vec<EqPreset>,
    /// `defaults.toml`'s `selected_profile` — where the active profile
    /// falls when the selected profile is deleted (a factory id, so
    /// the fallback itself can never be deleted).
    pub fallback_profile: ProfileId,
    /// What resolves beneath a custom profile's `config.toml` row
    /// ([`Defaults::custom_profile_baseline`] ⊕ the config `[profile]`
    /// shared layer): [`Command::AddProfile`]'s fill for unstated
    /// params and every custom profile's `baseline`.
    pub custom_profile_baseline: ProfileContent,
    /// The EQ-preset counterpart, over the preset-carried params.
    pub custom_eq_preset_baseline: PresetContent,
}

impl State {
    /// Builds the factory state — what a fresh install runs.
    #[must_use]
    pub fn new_from_defaults(defaults: &Defaults) -> Self {
        Self {
            power: defaults.power,
            lan_access: defaults.lan_access,
            selected_profile: defaults.selected_profile.clone(),
            profiles: defaults.profiles.clone(),
            eq_presets: defaults.eq_presets.clone(),
            fallback_profile: defaults.selected_profile.clone(),
            custom_profile_baseline: defaults.custom_profile_baseline.clone(),
            custom_eq_preset_baseline: defaults.custom_eq_preset_baseline.clone(),
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
    /// Never in practice: every `Some` EQ selection names an existing
    /// preset (load rejects a dangling EQ selection; the `EditProfile`
    /// EQ selection patch validates).
    fn overlay_of(&self, profile: &Profile) -> Option<&EqPreset> {
        profile.content.selected_eq_preset.as_ref().map(|id| {
            self.eq_preset(id)
                .expect("selected_eq_preset names an existing preset")
        })
    }

    /// The selected profile.
    ///
    /// # Panics
    ///
    /// Never in practice: `selected_profile` always names an existing
    /// profile (load rejects a dangling `selected_profile`; `SetProfile`
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
                    Some(preset) if def.category.is_preset_carried() => &preset.content.params,
                    _ => &profile.content.params,
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
                    lan_access: None,
                    params: None,
                    changed,
                    minted: None,
                })
            }
            Command::SetLanAccess { on } => {
                let changed = self.lan_access != on;
                self.lan_access = on;
                Ok(StateDiff {
                    power: None,
                    lan_access: changed.then_some(on),
                    params: None,
                    changed,
                    minted: None,
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
                    lan_access: None,
                    params: Some(self.resolved_batch(defs)),
                    changed: true,
                    minted: None,
                })
            }
            Command::EditProfile {
                id,
                name,
                params,
                selected_eq_preset,
            } => self.edit_profile(id, name, &params, selected_eq_preset, defs),
            Command::AddProfile {
                name,
                params,
                selected_eq_preset,
            } => self.add_profile(name, &params, selected_eq_preset, defs),
            Command::AddEqPreset { name, params } => self.add_eq_preset(name, &params, defs),
            Command::ResetProfile { id, only } => self.reset_profile(id, only.as_deref(), defs),
            Command::EditEqPreset { id, name, params } => {
                self.edit_eq_preset(id, name, &params, defs)
            }
            Command::RemoveProfile { id } => {
                let profile = self
                    .profile(&id)
                    .ok_or_else(|| ValidationError::UnknownProfile(id.0.clone()))?;
                if profile.is_factory {
                    return Err(ValidationError::FactoryDelete(id.0));
                }
                let was_selected = self.selected_profile == id;
                self.profiles.retain(|profile| profile.id != id);
                if was_selected {
                    self.selected_profile = self.fallback_profile.clone();
                }
                Ok(StateDiff {
                    power: None,
                    lan_access: None,
                    params: was_selected.then(|| self.resolved_batch(defs)),
                    changed: true,
                    minted: None,
                })
            }
            Command::RemoveEqPreset { id } => {
                let preset = self
                    .eq_preset(&id)
                    .ok_or_else(|| ValidationError::UnknownEqPreset(id.0.clone()))?;
                if preset.is_factory {
                    return Err(ValidationError::FactoryDelete(id.0));
                }
                // Deleting the selected profile's overlay ⇒ its own EQ
                // params apply again — computed before the fall below
                // rewrites the EQ selections.
                let live = self.selected().content.selected_eq_preset.as_ref() == Some(&id);
                // Every selecting profile falls to `None` at delete
                // time — resolved, never re-inherited, so a delete can
                // never activate a different preset (ADR-0003; an EQ
                // selection beneath would persist as the diverging
                // `"none"` sentinel under the write law).
                for profile in &mut self.profiles {
                    if profile.content.selected_eq_preset.as_ref() == Some(&id) {
                        profile.content.selected_eq_preset = None;
                    }
                }
                self.eq_presets.retain(|preset| preset.id != id);
                Ok(StateDiff {
                    power: None,
                    lan_access: None,
                    params: live.then(|| self.eq_batch(defs)),
                    changed: true,
                    minted: None,
                })
            }
            Command::ResetEqPreset { id, only } => self.reset_eq_preset(id, only.as_deref(), defs),
        }
    }

    /// [`Command::EditProfile`]: merge the param patch, apply the
    /// tri-state EQ selection patch and/or the rename, flush-iff-live
    /// — atomically.
    #[expect(
        clippy::option_option,
        reason = "tri-state: absent ≠ null ≠ id (ADR-0005)"
    )]
    fn edit_profile(
        &mut self,
        id: ProfileId,
        name: Option<String>,
        params: &HashMap<String, Vec<i16>>,
        eq_selection: Option<Option<PresetId>>,
        defs: &[ParameterDef],
    ) -> Result<StateDiff, ValidationError> {
        // Validate everything before mutating anything — commands are
        // atomic: reject all or apply all (ADR-0005).
        if let Some(name) = &name {
            validate_name(name)?;
        }
        for (param, values) in params {
            validate_write(defs, param, values)?;
        }
        if let Some(Some(preset_id)) = &eq_selection
            && self.eq_preset(preset_id).is_none()
        {
            return Err(ValidationError::UnknownEqPreset(preset_id.0.clone()));
        }
        let live = self.selected_profile == id;
        let profile = self
            .profile_mut(&id)
            .ok_or(ValidationError::UnknownProfile(id.0))?;
        if name.is_some() && profile.is_factory {
            return Err(ValidationError::FactoryRename(profile.id.0.clone()));
        }
        let name_changed = name.as_ref().is_some_and(|new| profile.name != *new);
        let eq_selection_changed = eq_selection
            .as_ref()
            .is_some_and(|new| profile.content.selected_eq_preset != *new);
        let mut params_changed = false;
        for def in defs {
            let Some(values) = params.get(&def.name) else {
                continue;
            };
            if profile.content.params[&def.name][..values.len()] != values[..] {
                profile.splice(&def.name, values);
                params_changed = true;
            }
        }
        if let Some(new) = eq_selection {
            profile.content.selected_eq_preset = new;
        }
        if let Some(new) = name {
            profile.name = new;
        }
        if !params_changed && !eq_selection_changed && !name_changed {
            return Ok(StateDiff::default());
        }
        // Live ⇒ the targeted profile is the selected one.
        let batch = live.then(|| self.edit_batch(params, eq_selection_changed, defs));
        Ok(StateDiff {
            power: None,
            lan_access: None,
            params: batch.filter(|batch| !batch.is_empty()),
            changed: true,
            minted: None,
        })
    }

    /// The engine batch a live [`Command::EditProfile`] flushes, in
    /// table order (structural counts precede their group's commit
    /// leaf). A selected preset shadows the profile's own EQ params
    /// *entirely* — the engine must not hear a shadowed write; and when
    /// the EQ selection itself moved, the whole effective EQ set lands
    /// alongside the non-EQ edits, never a half-apply (ADR-0003).
    fn edit_batch(
        &self,
        params: &HashMap<String, Vec<i16>>,
        eq_selection_changed: bool,
        defs: &[ParameterDef],
    ) -> Vec<(String, Vec<i16>)> {
        let profile = self.selected();
        let overlay = self.overlay_of(profile);
        defs.iter()
            .filter(|def| def.access.is_writable())
            .filter_map(|def| {
                if def.category.is_preset_carried() {
                    if eq_selection_changed {
                        let source = overlay
                            .map_or(&profile.content.params, |preset| &preset.content.params);
                        return Some((def.name.clone(), source[&def.name].clone()));
                    }
                    if overlay.is_some() {
                        return None;
                    }
                }
                params
                    .get(&def.name)
                    .map(|values| (def.name.clone(), values.clone()))
            })
            .collect()
    }

    /// [`Command::AddProfile`]: validate the content, mint the id,
    /// birth the item over the custom baseline.
    fn add_profile(
        &mut self,
        name: String,
        params: &HashMap<String, Vec<i16>>,
        eq_selection: Option<PresetId>,
        defs: &[ParameterDef],
    ) -> Result<StateDiff, ValidationError> {
        validate_name(&name)?;
        for (param, values) in params {
            validate_write(defs, param, values)?;
        }
        if let Some(preset_id) = &eq_selection
            && self.eq_preset(preset_id).is_none()
        {
            return Err(ValidationError::UnknownEqPreset(preset_id.0.clone()));
        }
        let id = mint_id(&name, |candidate| {
            self.profiles
                .iter()
                .any(|profile| profile.id.0 == candidate)
        });
        let mut content = self.custom_profile_baseline.clone();
        content.selected_eq_preset = eq_selection;
        for (param, values) in params {
            splice_head(&mut content.params, param, values);
        }
        self.profiles.push(Profile {
            id: ProfileId(id.clone()),
            name,
            is_factory: false,
            content,
            baseline: self.custom_profile_baseline.clone(),
        });
        Ok(StateDiff {
            power: None,
            lan_access: None,
            // The daemon never moves the active profile on an add — no
            // batch.
            params: None,
            changed: true,
            minted: Some(id),
        })
    }

    /// [`Command::AddEqPreset`]: as [`State::add_profile`], over the
    /// preset-carried params.
    fn add_eq_preset(
        &mut self,
        name: String,
        params: &HashMap<String, Vec<i16>>,
        defs: &[ParameterDef],
    ) -> Result<StateDiff, ValidationError> {
        validate_name(&name)?;
        for (param, values) in params {
            validate_eq_preset_write(defs, param, values)?;
        }
        let id = mint_id(&name, |candidate| {
            self.eq_presets
                .iter()
                .any(|preset| preset.id.0 == candidate)
        });
        let mut content = self.custom_eq_preset_baseline.clone();
        for (param, values) in params {
            splice_head(&mut content.params, param, values);
        }
        self.eq_presets.push(EqPreset {
            id: PresetId(id.clone()),
            name,
            is_factory: false,
            content,
            baseline: self.custom_eq_preset_baseline.clone(),
        });
        Ok(StateDiff {
            power: None,
            lan_access: None,
            params: None,
            changed: true,
            minted: Some(id),
        })
    }

    /// [`Command::EditEqPreset`]: merge the param patch and/or apply
    /// the rename into the global preset; flush iff the selected
    /// profile selects it (a rename alone never flushes).
    fn edit_eq_preset(
        &mut self,
        id: PresetId,
        name: Option<String>,
        params: &HashMap<String, Vec<i16>>,
        defs: &[ParameterDef],
    ) -> Result<StateDiff, ValidationError> {
        // Validate everything before mutating anything.
        if let Some(name) = &name {
            validate_name(name)?;
        }
        for (param, values) in params {
            validate_eq_preset_write(defs, param, values)?;
        }
        let live = self.selected().content.selected_eq_preset.as_ref() == Some(&id);
        let preset = self
            .eq_preset_mut(&id)
            .ok_or(ValidationError::UnknownEqPreset(id.0))?;
        if name.is_some() && preset.is_factory {
            return Err(ValidationError::FactoryRename(preset.id.0.clone()));
        }
        let name_changed = name.as_ref().is_some_and(|new| preset.name != *new);
        let mut batch = Vec::with_capacity(params.len());
        let mut params_changed = false;
        for def in defs {
            let Some(values) = params.get(&def.name) else {
                continue;
            };
            if preset.content.params[&def.name][..values.len()] != values[..] {
                preset.splice(&def.name, values);
                params_changed = true;
            }
            batch.push((def.name.clone(), values.clone()));
        }
        if let Some(new) = name {
            preset.name = new;
        }
        Ok(StateDiff {
            power: None,
            lan_access: None,
            params: (params_changed && live).then_some(batch),
            changed: params_changed || name_changed,
            minted: None,
        })
    }

    /// [`Command::ResetProfile`]: the un-edit (ADR-0007) — drop the
    /// profile's divergences so what resolves beneath applies again: a
    /// whole-item reset copies the baseline over the content (the EQ
    /// selection included), a scoped one exactly the
    /// `only`-named content keys; `name` never resets. Flush-iff-live:
    /// the full resolved set on a whole-item reset (a switch-sized
    /// batch), the restored entries — shadow-aware, via the edit batch
    /// rules — on a scoped one.
    fn reset_profile(
        &mut self,
        id: ProfileId,
        only: Option<&[String]>,
        defs: &[ParameterDef],
    ) -> Result<StateDiff, ValidationError> {
        let live = self.selected_profile == id;
        let profile = self
            .profile_mut(&id)
            .ok_or_else(|| ValidationError::UnknownProfile(id.0.clone()))?;
        // A profile's content keys: its writable params plus the EQ
        // selection (ADR-0007); `name` is a label, never one.
        if let Some(keys) = only
            && let Some(key) = keys.iter().find(|key| {
                *key != "selected_eq_preset" && !profile.content.params.contains_key(*key)
            })
        {
            return Err(ValidationError::NotAContentKey {
                id: id.0,
                key: key.clone(),
            });
        }
        let in_scope = |key: &str| only.is_none_or(|keys| keys.iter().any(|k| k == key));
        let restored: HashMap<String, Vec<i16>> = profile
            .content
            .params
            .iter()
            .filter(|(name, values)| {
                in_scope(name) && profile.baseline.params.get(*name) != Some(values)
            })
            .map(|(name, _)| (name.clone(), profile.baseline.params[name].clone()))
            .collect();
        let eq_selection_changed = in_scope("selected_eq_preset")
            && profile.content.selected_eq_preset != profile.baseline.selected_eq_preset;
        if restored.is_empty() && !eq_selection_changed {
            return Ok(StateDiff::default());
        }
        if only.is_none() {
            // Whole-item: the baseline *is* the reset content.
            profile.content = profile.baseline.clone();
        } else {
            for (name, values) in &restored {
                profile.content.params.insert(name.clone(), values.clone());
            }
            if eq_selection_changed {
                profile.content.selected_eq_preset = profile.baseline.selected_eq_preset.clone();
            }
        }
        let batch = live.then(|| match only {
            None => self.resolved_batch(defs),
            Some(_) => self.edit_batch(&restored, eq_selection_changed, defs),
        });
        Ok(StateDiff {
            power: None,
            lan_access: None,
            params: batch.filter(|batch| !batch.is_empty()),
            changed: true,
            minted: None,
        })
    }

    /// [`Command::ResetEqPreset`]: as [`State::reset_profile`], over
    /// the preset-carried params; flush iff the selected profile
    /// selects the preset — the resolved preset-carried set whole-item,
    /// exactly the restored entries scoped (the preset is the live
    /// overlay, so they are effective).
    fn reset_eq_preset(
        &mut self,
        id: PresetId,
        only: Option<&[String]>,
        defs: &[ParameterDef],
    ) -> Result<StateDiff, ValidationError> {
        let live = self.selected().content.selected_eq_preset.as_ref() == Some(&id);
        let preset = self
            .eq_preset_mut(&id)
            .ok_or_else(|| ValidationError::UnknownEqPreset(id.0.clone()))?;
        if let Some(keys) = only
            && let Some(key) = keys
                .iter()
                .find(|key| !preset.content.params.contains_key(*key))
        {
            return Err(ValidationError::NotAContentKey {
                id: id.0,
                key: key.clone(),
            });
        }
        let in_scope = |key: &str| only.is_none_or(|keys| keys.iter().any(|k| k == key));
        let restored: HashMap<String, Vec<i16>> = preset
            .content
            .params
            .iter()
            .filter(|(name, values)| {
                in_scope(name) && preset.baseline.params.get(*name) != Some(values)
            })
            .map(|(name, _)| (name.clone(), preset.baseline.params[name].clone()))
            .collect();
        if restored.is_empty() {
            return Ok(StateDiff::default());
        }
        if only.is_none() {
            // Whole-item: the baseline *is* the reset content.
            preset.content = preset.baseline.clone();
        } else {
            for (name, values) in &restored {
                preset.content.params.insert(name.clone(), values.clone());
            }
        }
        let batch = live.then(|| match only {
            None => self.eq_batch(defs),
            Some(_) => defs
                .iter()
                .filter_map(|def| {
                    restored
                        .get(&def.name)
                        .map(|values| (def.name.clone(), values.clone()))
                })
                .collect(),
        });
        Ok(StateDiff {
            power: None,
            lan_access: None,
            params: batch,
            changed: true,
            minted: None,
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
    /// LAN access toggle (ADR-0012) — the same root-scalar grammar as
    /// [`Command::SetPower`]; the engine never hears it.
    SetLanAccess {
        /// The requested LAN access state.
        on: bool,
    },
    /// Selects the active profile (global — all sessions follow).
    SetProfile {
        /// The profile to select.
        id: ProfileId,
    },
    /// The one sparse patch verb (ADR-0005): merges a param map into
    /// one profile and/or patches its EQ selection; flushes to the
    /// engine only when that profile is selected. Atomic — an invalid
    /// part rejects the whole command.
    EditProfile {
        /// The profile to edit.
        id: ProfileId,
        /// A rename patch — the new display name; `None` = untouched.
        /// Factory ids reject (their shipped names are fixed).
        name: Option<String>,
        /// The edited entries, keyed by 4-CC.
        params: HashMap<String, Vec<i16>>,
        /// Tri-state EQ selection patch: `None` = untouched,
        /// `Some(None)` = detach (the profile's own EQ params apply —
        /// "Off" is `None`, not a preset), `Some(Some(id))` = select.
        /// The EQ selection is per-profile — the target is explicit,
        /// unlike the global [`Command::SetProfile`].
        selected_eq_preset: Option<Option<PresetId>>,
    },
    /// Creates a custom profile from its **content** (ADR-0005): name +
    /// optional params + optional EQ selection — never a source
    /// reference ("clone" is a UI gesture; the client copies resolved
    /// values it already holds). Unstated params resolve from the
    /// custom baseline. The daemon mints the `user_<hash>` id, reported
    /// on [`StateDiff::minted`] — and never moves the active profile.
    AddProfile {
        /// The display name — a label, not identity (duplicates
        /// tolerated).
        name: String,
        /// The stated content params, keyed by 4-CC.
        params: HashMap<String, Vec<i16>>,
        /// The birth EQ selection; `None` (key absent on the wire) ⇒
        /// no preset.
        selected_eq_preset: Option<PresetId>,
    },
    /// Creates a custom EQ preset from its content — as
    /// [`Command::AddProfile`], over the preset-carried params.
    AddEqPreset {
        /// The display name.
        name: String,
        /// The stated content params, keyed by 4-CC.
        params: HashMap<String, Vec<i16>>,
    },
    /// The un-edit (ADR-0007): drops the profile's `config.toml`
    /// divergences — whole-item, or scoped to the `only`-named content
    /// keys — so the cascade beneath resolves. Valid on **every** item:
    /// factory ids fall to their bundled defaults, customs to the
    /// shared layers (never their birth clone). A whole-item reset
    /// drops the EQ selection override too; `name` never resets.
    ResetProfile {
        /// The profile to reset.
        id: ProfileId,
        /// The scope: `None` ⇒ the whole item; `Some` ⇒ exactly these
        /// content keys (param 4-CCs and/or `"selected_eq_preset"`).
        /// A key the profile doesn't carry rejects the whole command.
        only: Option<Vec<String>>,
    },
    /// Writes a param map into one EQ preset (preset-carried params only).
    ///
    /// Flushes to the engine only when the selected profile selects
    /// that preset — and, presets being global, is visible to every
    /// profile selecting it.
    EditEqPreset {
        /// The preset to edit.
        id: PresetId,
        /// A rename patch — as [`Command::EditProfile`]'s.
        name: Option<String>,
        /// The edited entries, keyed by 4-CC.
        params: HashMap<String, Vec<i16>>,
    },
    /// Drops an EQ preset's `config.toml` divergences — as
    /// [`Command::ResetProfile`], over the preset-carried params.
    ResetEqPreset {
        /// The preset to reset.
        id: PresetId,
        /// The scope, over the params the preset carries — as
        /// [`Command::ResetProfile`]'s.
        only: Option<Vec<String>>,
    },
    /// Deletes a custom profile (factory ids reject). Deleting the
    /// selected profile falls the active profile back to
    /// `defaults.toml`'s `selected_profile`, batching its full
    /// resolved set.
    RemoveProfile {
        /// The profile to delete.
        id: ProfileId,
    },
    /// Deletes a custom EQ preset (factory ids reject). Every profile
    /// selecting it falls to an **explicit** `None` — never the EQ
    /// selection beneath (ADR-0003); flush-iff-live pushes the
    /// selected profile's own EQ.
    RemoveEqPreset {
        /// The preset to delete.
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
    /// New LAN access state, when it changed — drives the daemon's
    /// listener rebind and connection severing, never the engine.
    pub lan_access: Option<bool>,
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
    /// The server-minted id of an `add_*`'s fresh item — echoed on the
    /// wire ack's `id`, so the originator applies locally without
    /// waiting for a snapshot (ADR-0005).
    pub minted: Option<String>,
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
    /// The preset id names no EQ preset.
    #[error("unknown EQ preset `{0}`")]
    UnknownEqPreset(String),
    /// The parameter is not preset-carried — EQ presets own exactly the
    /// `category ∈ {Ieq, Geq}` params (ADR-0003).
    #[error("parameter `{0}` is not preset-carried (not an IEQ/GEQ param)")]
    NotPresetCarried(String),
    /// The display name is empty after trimming — names are labels
    /// (duplicates tolerated; identity lives in the id), but a blank
    /// label is unusable.
    #[error("name is empty after trimming")]
    EmptyName,
    /// Factory items keep their shipped names — a `name` patch on one
    /// rejects (a Reset restores content, never names).
    #[error("factory item `{0}` cannot be renamed")]
    FactoryRename(String),
    /// Factory items never delete — a Reset falls them back to their
    /// bundled defaults instead.
    #[error("factory item `{0}` cannot be deleted")]
    FactoryDelete(String),
    /// A `reset_*.only` key the target item doesn't carry — content
    /// keys are an item's own resettable row keys: its writable params,
    /// plus `selected_eq_preset` for profiles; `name` is a label, never
    /// reset (ADR-0007).
    #[error("`{key}` is not a content key of `{id}`")]
    NotAContentKey {
        /// The reset target.
        id: String,
        /// The offending scope key.
        key: String,
    },
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

/// Validates a display name: non-empty after trimming (ADR-0005 —
/// names are labels, duplicates tolerated).
fn validate_name(name: &str) -> Result<(), ValidationError> {
    if name.trim().is_empty() {
        return Err(ValidationError::EmptyName);
    }
    Ok(())
}

/// Mints a fresh custom-item id — `user_` + four hex digits of a name
/// hash, re-hashed until it collides with nothing `taken` reports (the
/// `user_` prefix keeps factory ids and the reserved `"none"` sentinel
/// out of reach). Ids persist in `config.toml`; a mint is a one-shot —
/// stability across restarts comes from persistence, never
/// re-derivation.
fn mint_id(name: &str, taken: impl Fn(&str) -> bool) -> String {
    use std::hash::{Hash, Hasher};
    let rehash = |seed: u64, salt: &str| {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        seed.hash(&mut hasher);
        salt.hash(&mut hasher);
        hasher.finish()
    };
    let mut hash = rehash(0, name);
    loop {
        let id = format!("user_{:04x}", hash & 0xffff);
        if !taken(&id) {
            return id;
        }
        hash = rehash(hash, name);
    }
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
        let content = ProfileContent {
            selected_eq_preset: None,
            params: base_params(table),
        };
        Profile {
            id: ProfileId(id.into()),
            name: name.into(),
            is_factory: true,
            content: content.clone(),
            baseline: content,
        }
    }

    fn preset(id: &str, name: &str, iebt: &[i16], table: &[ParameterDef]) -> EqPreset {
        let mut params = base_eq_params(table);
        params.insert("ieon".into(), vec![1]);
        params.insert("iebt".into(), iebt.to_vec());
        let content = PresetContent { params };
        EqPreset {
            id: PresetId(id.into()),
            name: name.into(),
            is_factory: true,
            content: content.clone(),
            baseline: content,
        }
    }

    fn defaults() -> Defaults {
        let table = defs();
        let mut music = profile("music", "Music", &table);
        music.splice("dvla", &[4]);
        music.baseline = music.content.clone();
        Defaults {
            power: true,
            lan_access: false,
            selected_profile: ProfileId("music".into()),
            profiles: vec![profile("movie", "Movie", &table), music],
            eq_presets: vec![
                preset("open", "Open", &[117, 133, -27, -240], &table),
                preset("rich", "Rich", &[67, 95, -55, -235], &table),
            ],
            custom_profile_baseline: ProfileContent {
                selected_eq_preset: None,
                params: base_params(&table),
            },
            custom_eq_preset_baseline: PresetContent {
                params: base_eq_params(&table),
            },
        }
    }

    fn rich() -> PresetId {
        PresetId("rich".into())
    }

    /// An EQ-selection-only `edit_profile` patch — the tri-state's
    /// `Some(None)` detaches, `Some(Some(id))` selects.
    fn select_preset(profile_id: &str, id: Option<PresetId>) -> Command {
        Command::EditProfile {
            name: None,
            id: ProfileId(profile_id.into()),
            params: HashMap::new(),
            selected_eq_preset: Some(id),
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
        assert_eq!(state.selected().content.params["dvla"], vec![4]);
        assert!(state.selected().is_factory);
        assert_eq!(state.selected().content.selected_eq_preset, None);
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

    /// Issue #70: `set_lan_access` follows the root-scalar grammar —
    /// the flip lands on the scalar, the diff reports it (the daemon's
    /// rebind/sever fan-out rides it), and the engine hears nothing.
    #[test]
    fn set_lan_access_flips_the_scalar_and_reports_the_change() {
        let mut state = State::new_from_defaults(&defaults());
        assert!(!state.lan_access, "ships off (ADR-0012)");
        let diff = state
            .apply(Command::SetLanAccess { on: true }, &defs())
            .unwrap();
        assert!(state.lan_access);
        assert_eq!(diff.lan_access, Some(true));
        assert_eq!(diff.power, None);
        assert_eq!(diff.params, None, "the engine never hears LAN access");
        assert!(!diff.is_empty());
    }

    #[test]
    fn set_lan_access_to_the_current_value_is_a_no_op() {
        let mut state = State::new_from_defaults(&defaults());
        let diff = state
            .apply(Command::SetLanAccess { on: false }, &defs())
            .unwrap();
        assert!(!state.lan_access);
        assert!(diff.is_empty());
        assert_eq!(diff.lan_access, None);
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

    /// Behavior 4 (issue #18): a switch updates the active profile and hands
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
    fn set_profile_to_the_selected_profile_is_a_no_op() {
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
            name: None,
            id: ProfileId(id.into()),
            params: entries
                .iter()
                .map(|&(name, values)| (name.to_string(), values.to_vec()))
                .collect(),
            selected_eq_preset: None,
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
        assert_eq!(music.content.params["genb"], vec![4]);
        assert_eq!(
            music.content.params["gebg"],
            vec![5, -5, 0, 0],
            "short band arrays overlay the head of the full allocation"
        );
        assert_eq!(
            music.baseline.params["gebg"],
            vec![0; 4],
            "baseline untouched"
        );
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
            state
                .profile(&ProfileId("movie".into()))
                .unwrap()
                .content
                .params["dvla"],
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
                    only: None,
                },
                &defs(),
            )
            .unwrap();
        assert_eq!(
            state.selected().content.params["dvla"],
            vec![4],
            "factory value"
        );
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
                    only: None,
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
                    only: None,
                },
                &defs(),
            )
            .unwrap();
        assert!(diff.is_empty());

        assert_eq!(
            state.apply(
                Command::ResetProfile {
                    id: ProfileId("ghost".into()),
                    only: None,
                },
                &defs(),
            ),
            Err(ValidationError::UnknownProfile("ghost".into())),
        );
    }

    /// Behavior 1 (issue #57), state half: a `selected_eq_preset` patch
    /// stores the EQ selection on that profile and batches the resolved
    /// preset-carried set — the preset's params shadow the profile's
    /// own *entirely* (a diverging own `gebg` must not leak through).
    #[test]
    fn an_eq_selection_patch_selects_and_batches_the_presets_resolved_eq_set() {
        let mut state = State::new_from_defaults(&defaults());
        let _ = state
            .apply(edit("music", &[("gebg", &[5, -5])]), &defs())
            .unwrap();

        let diff = state
            .apply(select_preset("music", Some(rich())), &defs())
            .unwrap();
        assert_eq!(state.selected().content.selected_eq_preset, Some(rich()));
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
            state.selected().content.params["gebg"],
            vec![5, -5, 0, 0],
            "the profile's own EQ params survive underneath"
        );
    }

    /// Behavior 1 (issue #57), state half: a `null` EQ selection patch
    /// detaches — the batch carries the profile's own EQ params again.
    #[test]
    fn a_null_eq_selection_patch_detaches_and_batches_the_profiles_own_eq() {
        let mut state = State::new_from_defaults(&defaults());
        let _ = state
            .apply(edit("music", &[("gebg", &[5, -5])]), &defs())
            .unwrap();
        let _ = state
            .apply(select_preset("music", Some(rich())), &defs())
            .unwrap();

        let diff = state.apply(select_preset("music", None), &defs()).unwrap();
        assert_eq!(state.selected().content.selected_eq_preset, None);
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

    /// Behavior 5 (issue #23), state half: an EQ selection on a
    /// non-selected profile persists without a batch; re-selecting the
    /// current preset is a no-op; unknown ids are rejected unchanged.
    #[test]
    fn an_eq_selection_patch_flushes_iff_live_and_validates_ids() {
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
                .content
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

    /// Behavior 2 (issue #57), state half: a mixed patch (params + EQ
    /// selection) applies atomically — the EQ selection lands, the params
    /// merge (shadowed EQ params persist beneath), and one batch
    /// carries the new effective EQ set alongside the non-EQ edits.
    #[test]
    fn a_mixed_patch_applies_atomically_and_batches_the_effective_set() {
        let mut state = State::new_from_defaults(&defaults());
        let diff = state
            .apply(
                Command::EditProfile {
                    name: None,
                    id: ProfileId("music".into()),
                    params: [
                        ("dvla".to_string(), vec![9_i16]),
                        ("gebg".to_string(), vec![7_i16]),
                    ]
                    .into(),
                    selected_eq_preset: Some(Some(rich())),
                },
                &defs(),
            )
            .unwrap();
        let music = state.selected();
        assert_eq!(music.content.selected_eq_preset, Some(rich()));
        assert_eq!(music.content.params["dvla"], vec![9]);
        assert_eq!(
            music.content.params["gebg"],
            vec![7, 0, 0, 0],
            "the shadowed edit persists beneath the overlay"
        );
        assert_eq!(
            diff.params.unwrap(),
            vec![
                ("dvla".to_string(), vec![9_i16]),
                ("iebt".to_string(), vec![67, 95, -55, -235]),
                ("ieon".to_string(), vec![1]),
                ("genb".to_string(), vec![2]),
                ("gebg".to_string(), vec![0; 4]), // rich's, not the edit's [7]
            ],
            "one atomic batch: the preset's EQ set + the non-EQ edit"
        );

        // Detach + edit in one patch: the batch carries the profile's
        // own EQ params with the fresh edit already merged.
        let diff = state
            .apply(
                Command::EditProfile {
                    name: None,
                    id: ProfileId("music".into()),
                    params: [("gebg".to_string(), vec![5_i16, -5])].into(),
                    selected_eq_preset: Some(None),
                },
                &defs(),
            )
            .unwrap();
        assert_eq!(state.selected().content.selected_eq_preset, None);
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

    /// Behavior 2 (issue #57), rejection half: an invalid part rejects
    /// the whole mixed patch — valid params must not land beside an
    /// unknown preset, nor a valid EQ selection beside a bad param.
    #[test]
    fn a_mixed_patch_with_any_invalid_part_rejects_whole() {
        let mut state = State::new_from_defaults(&defaults());
        let before = state.clone();
        let rejected = [
            (
                Command::EditProfile {
                    name: None,
                    id: ProfileId("music".into()),
                    params: [("dvla".to_string(), vec![9_i16])].into(),
                    selected_eq_preset: Some(Some(PresetId("ghost".into()))),
                },
                ValidationError::UnknownEqPreset("ghost".into()),
            ),
            (
                Command::EditProfile {
                    name: None,
                    id: ProfileId("music".into()),
                    params: [("dvla".to_string(), vec![11_i16])].into(),
                    selected_eq_preset: Some(Some(rich())),
                },
                ValidationError::OutOfRange {
                    name: "dvla".into(),
                    index: 0,
                    value: 11,
                    min: 0,
                    max: 10,
                },
            ),
            (
                Command::EditProfile {
                    name: None,
                    id: ProfileId("ghost".into()),
                    params: HashMap::new(),
                    selected_eq_preset: Some(Some(rich())),
                },
                ValidationError::UnknownProfile("ghost".into()),
            ),
        ];
        for (command, expected) in rejected {
            assert_eq!(state.apply(command, &defs()), Err(expected));
            assert_eq!(state, before, "a rejected patch must not mutate");
        }
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
            name: None,
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
        assert_eq!(preset.content.params["iebt"], vec![100, 95, -55, -235]);

        let diff = state.apply(edit_rich(&[42, 43]), &defs()).unwrap();
        assert_eq!(
            diff.params.unwrap(),
            vec![("iebt".to_string(), vec![42, 43])],
            "live edit batches exactly the edited entries"
        );
        let preset = state.eq_preset(&PresetId("rich".into())).unwrap();
        assert_eq!(preset.content.params["iebt"], vec![42, 43, -55, -235]);
        assert_eq!(
            preset.baseline.params["iebt"],
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
            name: None,
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
        assert_eq!(state.selected().content.params["gebg"], vec![9, 0, 0, 0]);

        // A mixed edit batches only the effective (non-shadowed) half.
        let diff = state
            .apply(edit("music", &[("dvla", &[9]), ("gebg", &[7])]), &defs())
            .unwrap();
        assert_eq!(
            diff.params.unwrap(),
            vec![("dvla".to_string(), vec![9_i16])],
        );
    }

    /// Behavior 2 (issue #26 A), state half: `add_profile` births the
    /// item over the **custom baseline** (not any factory profile's
    /// values), reports the minted id with no engine batch — and two
    /// adds with identical content mint distinct ids (the collision
    /// loop), so names stay labels and ids identity.
    #[test]
    fn add_profile_fills_from_the_custom_baseline_and_never_collides() {
        let mut state = State::new_from_defaults(&defaults());
        let add = || Command::AddProfile {
            name: "Late Night".into(),
            params: [("gebg".to_string(), vec![5_i16, -5])].into(),
            selected_eq_preset: None,
        };

        let diff = state.apply(add(), &defs()).unwrap();
        let id = diff.minted.clone().expect("an add mints an id");
        // Opaque beyond the prefix (epic) — the format is unpinned.
        assert!(id.starts_with("user_"), "got {id:?}");
        assert!(!diff.is_empty());
        assert_eq!(diff.params, None, "an add never touches the engine");

        let profile = state.profile(&ProfileId(id.clone())).unwrap();
        assert_eq!(profile.name, "Late Night");
        assert!(!profile.is_factory);
        assert_eq!(
            profile.content.selected_eq_preset, None,
            "absent ⇒ no preset"
        );
        assert_eq!(
            profile.content.params["gebg"],
            vec![5, -5, 0, 0],
            "stated content"
        );
        assert_eq!(
            profile.content.params["dvla"],
            vec![7],
            "unstated params run the custom baseline — not Music's 4"
        );
        assert_eq!(profile.baseline, state.custom_profile_baseline);

        // Identical content again: a fresh id, both items live.
        let second = state.apply(add(), &defs()).unwrap().minted.unwrap();
        assert_ne!(second, id, "identical content must not collide");
        assert_eq!(state.profiles.len(), 4);

        // The add family validates like edit (ADR-0005): bad content
        // rejects whole, nothing minted.
        let before = state.clone();
        let rejected: [(Command, ValidationError); 3] = [
            (
                Command::AddProfile {
                    name: "  \t ".into(),
                    params: HashMap::new(),
                    selected_eq_preset: None,
                },
                ValidationError::EmptyName,
            ),
            (
                Command::AddProfile {
                    name: "X".into(),
                    params: HashMap::new(),
                    selected_eq_preset: Some(PresetId("ghost".into())),
                },
                ValidationError::UnknownEqPreset("ghost".into()),
            ),
            (
                Command::AddEqPreset {
                    name: "X".into(),
                    params: [("dvla".to_string(), vec![4_i16])].into(),
                },
                ValidationError::NotPresetCarried("dvla".into()),
            ),
        ];
        for (command, expected) in rejected {
            assert_eq!(state.apply(command, &defs()), Err(expected));
            assert_eq!(state, before, "a rejected add must not mutate");
        }
        assert_eq!(
            ValidationError::EmptyName.to_string(),
            "name is empty after trimming"
        );
    }

    /// Behavior 3 (issue #26 A), state half: a rename is a `name`
    /// patch on the one sparse verb — atomic with the rest (a valid
    /// name beside a bad param rejects whole), a same-name patch a
    /// no-op, factory names immutable.
    #[test]
    fn a_name_patch_renames_customs_atomically() {
        let mut state = State::new_from_defaults(&defaults());
        let minted = state
            .apply(
                Command::AddProfile {
                    name: "Music 2".into(),
                    params: HashMap::new(),
                    selected_eq_preset: None,
                },
                &defs(),
            )
            .unwrap()
            .minted
            .unwrap();
        let rename = |name: &str, dvla: &[i16]| Command::EditProfile {
            id: ProfileId(minted.clone()),
            name: Some(name.into()),
            params: [("dvla".to_string(), dvla.to_vec())].into(),
            selected_eq_preset: None,
        };

        let diff = state.apply(rename("Late Night", &[3]), &defs()).unwrap();
        assert!(!diff.is_empty());
        let profile = state.profile(&ProfileId(minted.clone())).unwrap();
        assert_eq!(profile.name, "Late Night");
        assert_eq!(profile.content.params["dvla"], vec![3], "one atomic patch");

        let before = state.clone();
        assert_eq!(
            state.apply(rename("Later", &[99]), &defs()),
            Err(ValidationError::OutOfRange {
                name: "dvla".into(),
                index: 0,
                value: 99,
                min: 0,
                max: 10,
            }),
        );
        assert_eq!(state, before, "a valid rename beside a bad param");

        let diff = state.apply(rename("Late Night", &[3]), &defs()).unwrap();
        assert!(diff.is_empty(), "restating the current name and value");

        assert_eq!(
            state.apply(
                Command::EditEqPreset {
                    id: PresetId("rich".into()),
                    name: Some("Loud".into()),
                    params: HashMap::new(),
                },
                &defs(),
            ),
            Err(ValidationError::FactoryRename("rich".into())),
        );
        assert_eq!(
            ValidationError::FactoryRename("rich".into()).to_string(),
            "factory item `rich` cannot be renamed"
        );
    }

    /// Behavior 2 (issue #26 A), preset half: `add_eq_preset` births
    /// over the preset-carried custom baseline; a birth EQ selection on
    /// `add_profile` resolves at once.
    #[test]
    fn add_eq_preset_fills_from_the_custom_baseline_and_is_selectable() {
        let mut state = State::new_from_defaults(&defaults());
        let diff = state
            .apply(
                Command::AddEqPreset {
                    name: "My Rich".into(),
                    params: [("iebt".to_string(), vec![9_i16])].into(),
                },
                &defs(),
            )
            .unwrap();
        let id = diff.minted.expect("an add mints an id");
        let preset = state.eq_preset(&PresetId(id.clone())).unwrap();
        assert!(!preset.is_factory);
        assert_eq!(preset.content.params["iebt"], vec![9, 0, 0, 0]);
        assert_eq!(
            preset.content.params["ieon"],
            vec![0],
            "unstated params run the custom baseline — no factory row leaks"
        );
        assert_eq!(preset.baseline, state.custom_eq_preset_baseline);

        let diff = state
            .apply(
                Command::AddProfile {
                    name: "Paired".into(),
                    params: HashMap::new(),
                    selected_eq_preset: Some(PresetId(id.clone())),
                },
                &defs(),
            )
            .unwrap();
        let paired = state.profile(&ProfileId(diff.minted.unwrap())).unwrap();
        assert_eq!(
            paired.content.selected_eq_preset,
            Some(PresetId(id)),
            "a birth EQ selection resolves at once"
        );
    }

    /// Adds a bare custom EQ preset, returning the minted id.
    fn add_eq_preset(state: &mut State, name: &str) -> PresetId {
        state
            .apply(
                Command::AddEqPreset {
                    name: name.into(),
                    params: HashMap::new(),
                },
                &defs(),
            )
            .unwrap()
            .minted
            .map(PresetId)
            .unwrap()
    }

    /// Behavior 5 (issue #26 A), state half: deleting a custom EQ
    /// preset falls every selector to a resolved `None` — never
    /// re-inherited, so an EQ selection beneath can't surface (ADR-0003) —
    /// and flushes iff the selected profile selected it.
    #[test]
    fn removing_an_eq_preset_falls_every_selector_to_none() {
        let mut state = State::new_from_defaults(&defaults());
        let preset_id = add_eq_preset(&mut state, "Doomed");
        let _ = state
            .apply(select_preset("movie", Some(preset_id.clone())), &defs())
            .unwrap();
        let _ = state
            .apply(select_preset("music", Some(preset_id.clone())), &defs())
            .unwrap();

        let diff = state
            .apply(
                Command::RemoveEqPreset {
                    id: preset_id.clone(),
                },
                &defs(),
            )
            .unwrap();
        assert!(state.eq_preset(&preset_id).is_none(), "the preset is gone");
        for id in ["movie", "music"] {
            assert_eq!(
                state
                    .profile(&ProfileId(id.into()))
                    .unwrap()
                    .content
                    .selected_eq_preset,
                None,
                "{id}: fallen to None at delete time"
            );
        }
        let batch = diff.params.expect("music selected it — the delete flushes");
        assert_eq!(batch.len(), 4, "the fixture's preset-carried set");
        assert!(
            batch.contains(&("ieon".to_string(), vec![0])),
            "music's own"
        );

        // No selectors ⇒ nothing falls, engine silent.
        let idle = add_eq_preset(&mut state, "Idle");
        let diff = state
            .apply(Command::RemoveEqPreset { id: idle }, &defs())
            .unwrap();
        assert!(!diff.is_empty());
        assert_eq!(diff.params, None);
    }

    /// Behaviors 4 + 6 (issue #26 A), state half: deleting the
    /// selected profile falls the active profile back to `fallback_profile`
    /// with its resolved set; factory deletes reject.
    #[test]
    fn removing_the_selected_profile_falls_back_and_factories_reject() {
        let mut state = State::new_from_defaults(&defaults());
        let profile_id = state
            .apply(
                Command::AddProfile {
                    name: "Bass".into(),
                    params: HashMap::new(),
                    selected_eq_preset: None,
                },
                &defs(),
            )
            .unwrap()
            .minted
            .map(ProfileId)
            .unwrap();
        let _ = state
            .apply(
                Command::SetProfile {
                    id: profile_id.clone(),
                },
                &defs(),
            )
            .unwrap();
        let diff = state
            .apply(Command::RemoveProfile { id: profile_id }, &defs())
            .unwrap();
        assert_eq!(state.selected_profile, ProfileId("music".into()));
        assert!(diff.params.is_some(), "the fallback's resolved set flushes");

        assert_eq!(
            state.apply(
                Command::RemoveProfile {
                    id: ProfileId("music".into()),
                },
                &defs(),
            ),
            Err(ValidationError::FactoryDelete("music".into())),
        );
        assert_eq!(
            state.apply(
                Command::RemoveEqPreset {
                    id: PresetId("rich".into()),
                },
                &defs(),
            ),
            Err(ValidationError::FactoryDelete("rich".into())),
        );
        assert_eq!(
            ValidationError::FactoryDelete("music".into()).to_string(),
            "factory item `music` cannot be deleted"
        );
    }

    /// Behavior 1 (issue #26 B), state half: a whole-item profile
    /// reset drops every divergence — params AND the EQ selection
    /// override — while `name` survives; a custom falls to the shared
    /// layers (its custom baseline), never its birth clone.
    #[test]
    fn whole_item_reset_drops_params_and_the_eq_selection_override() {
        let table = defs();
        let mut state = State::new_from_defaults(&defaults());
        let _ = state
            .apply(edit("music", &[("dvla", &[9])]), &table)
            .unwrap();
        let _ = state
            .apply(select_preset("music", Some(rich())), &table)
            .unwrap();

        let diff = state
            .apply(
                Command::ResetProfile {
                    id: ProfileId("music".into()),
                    only: None,
                },
                &table,
            )
            .unwrap();
        assert_eq!(
            state.selected().content.params["dvla"],
            vec![4],
            "factory value"
        );
        assert_eq!(
            state.selected().content.selected_eq_preset,
            None,
            "the EQ selection override drops with the whole item"
        );
        let batch = diff.params.expect("live reset flushes the full set");
        assert!(batch.contains(&("dvla".to_string(), vec![4])));
        assert!(
            batch.contains(&("ieon".to_string(), vec![0])),
            "the profile's own EQ applies again"
        );

        // The custom half: born diverging with an EQ selection, renamed.
        let minted = state
            .apply(
                Command::AddProfile {
                    name: "Music 2".into(),
                    params: [("dvla".to_string(), vec![2_i16])].into(),
                    selected_eq_preset: Some(rich()),
                },
                &table,
            )
            .unwrap()
            .minted
            .map(ProfileId)
            .unwrap();
        let _ = state
            .apply(
                Command::EditProfile {
                    id: minted.clone(),
                    name: Some("Late Night".into()),
                    params: HashMap::new(),
                    selected_eq_preset: None,
                },
                &table,
            )
            .unwrap();
        let diff = state
            .apply(
                Command::ResetProfile {
                    id: minted.clone(),
                    only: None,
                },
                &table,
            )
            .unwrap();
        assert_eq!(diff.params, None, "not selected — the engine is silent");
        let custom = state.profile(&minted).unwrap();
        assert_eq!(
            custom.content.params["dvla"],
            vec![7],
            "the shared layers — never the birth clone's 2"
        );
        assert_eq!(
            custom.content.selected_eq_preset, None,
            "EQ selection dropped"
        );
        assert_eq!(custom.name, "Late Night", "`name` never resets");
        assert_eq!(custom.content, custom.baseline, "nothing left diverging");
    }

    /// Behavior 2 (issue #26 B), state half: `only` clears exactly the
    /// named content keys — the rest keep their divergences — batching
    /// the restored entries shadow-aware; `only: ["selected_eq_preset"]`
    /// drops just the EQ selection; an empty or divergence-free scope is a
    /// no-op.
    #[test]
    fn scoped_reset_clears_exactly_the_named_keys() {
        let table = defs();
        let mut state = State::new_from_defaults(&defaults());
        let reset_music = |only: &[&str]| Command::ResetProfile {
            id: ProfileId("music".into()),
            only: Some(only.iter().map(ToString::to_string).collect()),
        };
        let _ = state
            .apply(edit("music", &[("gebg", &[5, -5]), ("dvla", &[9])]), &table)
            .unwrap();

        let diff = state.apply(reset_music(&["gebg"]), &table).unwrap();
        assert_eq!(
            diff.params.unwrap(),
            vec![("gebg".to_string(), vec![0; 4])],
            "exactly the restored entry"
        );
        assert_eq!(
            state.selected().content.params["dvla"],
            vec![9],
            "dvla untouched"
        );
        assert_eq!(
            state.selected().baseline.params["dvla"],
            vec![4],
            "…and diverging"
        );

        // An EQ-selection-only scope: the effective EQ set flushes.
        let _ = state
            .apply(select_preset("music", Some(rich())), &table)
            .unwrap();
        let diff = state
            .apply(reset_music(&["selected_eq_preset"]), &table)
            .unwrap();
        assert_eq!(state.selected().content.selected_eq_preset, None);
        assert_eq!(
            state.selected().content.params["dvla"],
            vec![9],
            "params untouched"
        );
        assert_eq!(
            diff.params.unwrap(),
            vec![
                ("iebt".to_string(), vec![0_i16; 4]),
                ("ieon".to_string(), vec![0]),
                ("genb".to_string(), vec![2]),
                ("gebg".to_string(), vec![0; 4]),
            ],
            "the profile's own EQ set — never a half-apply"
        );

        // Scoped under an overlay: a shadowed restore persists with the
        // engine silent.
        let _ = state
            .apply(select_preset("music", Some(rich())), &table)
            .unwrap();
        let _ = state
            .apply(edit("music", &[("gebg", &[7])]), &table)
            .unwrap();
        let diff = state.apply(reset_music(&["gebg"]), &table).unwrap();
        assert!(!diff.is_empty());
        assert_eq!(diff.params, None, "shadowed ⇒ no engine batch");
        assert_eq!(state.selected().content.params["gebg"], vec![0; 4]);

        // Empty scope / nothing diverging in scope ⇒ no-op.
        assert!(state.apply(reset_music(&[]), &table).unwrap().is_empty());
        assert!(
            state
                .apply(reset_music(&["gebg"]), &table)
                .unwrap()
                .is_empty()
        );

        // The preset counterpart: scoped to one of its carried params.
        let edit_rich = Command::EditEqPreset {
            name: None,
            id: rich(),
            params: [
                ("iebt".to_string(), vec![100_i16]),
                ("gebg".to_string(), vec![9_i16]),
            ]
            .into(),
        };
        let _ = state.apply(edit_rich, &table).unwrap();
        let diff = state
            .apply(
                Command::ResetEqPreset {
                    id: rich(),
                    only: Some(vec!["iebt".into()]),
                },
                &table,
            )
            .unwrap();
        assert_eq!(
            diff.params.unwrap(),
            vec![("iebt".to_string(), vec![67, 95, -55, -235])],
            "live (music selects rich): exactly the restored entry"
        );
        let preset = state.eq_preset(&rich()).unwrap();
        assert_eq!(
            preset.content.params["gebg"],
            vec![9, 0, 0, 0],
            "gebg untouched"
        );
    }

    /// Behavior 2 (issue #26 B), rejection half: an `only` key the item
    /// doesn't carry — unknown or read-only 4-CCs, `name`, a preset's
    /// `selected_eq_preset`, a non-preset-carried param on a preset —
    /// rejects the whole command as `NotAContentKey`, state untouched.
    #[test]
    fn reset_only_keys_the_item_does_not_carry_reject() {
        let table = defs();
        let mut state = State::new_from_defaults(&defaults());
        let _ = state
            .apply(edit("music", &[("dvla", &[9])]), &table)
            .unwrap();
        let before = state.clone();

        let profile_cases = [["vnnb"], ["xxxx"], ["name"]];
        for keys in profile_cases {
            let error = state
                .apply(
                    Command::ResetProfile {
                        id: ProfileId("music".into()),
                        only: Some(vec![keys[0].into()]),
                    },
                    &table,
                )
                .unwrap_err();
            assert_eq!(
                error,
                ValidationError::NotAContentKey {
                    id: "music".into(),
                    key: keys[0].into(),
                },
            );
            assert_eq!(state, before, "a rejected reset must not mutate");
        }
        // A valid key beside a bad one rejects whole — dvla stays
        // diverging.
        let _ = state
            .apply(
                Command::ResetProfile {
                    id: ProfileId("music".into()),
                    only: Some(vec!["dvla".into(), "vnnb".into()]),
                },
                &table,
            )
            .unwrap_err();
        assert_eq!(state, before);

        for key in ["dvla", "selected_eq_preset"] {
            assert_eq!(
                state.apply(
                    Command::ResetEqPreset {
                        id: rich(),
                        only: Some(vec![key.into()]),
                    },
                    &table,
                ),
                Err(ValidationError::NotAContentKey {
                    id: "rich".into(),
                    key: key.into(),
                }),
            );
        }
        assert_eq!(
            ValidationError::NotAContentKey {
                id: "rich".into(),
                key: "dvla".into(),
            }
            .to_string(),
            "`dvla` is not a content key of `rich`"
        );
    }

    /// Behavior 3 (issue #26 B), state half: every item carries its
    /// baseline — divergence's input, client-derived on the wire
    /// (ADR-0005) — and edits move the resolved side only: the
    /// baselines hold still, so resolved ≠ baseline appears on edit
    /// and disappears on an edit back to the baseline value.
    #[test]
    fn baselines_hold_still_beneath_edits_as_divergence_inputs() {
        let table = defs();
        let mut state = State::new_from_defaults(&defaults());
        let music = state.selected();
        assert_eq!(music.content, music.baseline, "fresh ⇒ nothing diverges");

        let _ = state
            .apply(edit("music", &[("gebg", &[5, -5]), ("dvla", &[9])]), &table)
            .unwrap();
        let _ = state
            .apply(select_preset("music", Some(rich())), &table)
            .unwrap();
        let music = state.selected();
        assert_eq!(music.content.params["dvla"], vec![9]);
        assert_eq!(music.baseline.params["dvla"], vec![4], "the baseline holds");
        assert_eq!(music.baseline.params["gebg"], vec![0; 4]);
        assert_eq!(music.content.selected_eq_preset, Some(rich()));
        assert_eq!(
            music.baseline.selected_eq_preset, None,
            "the EQ selection's too"
        );

        // Editing back to the baseline values erases the divergence —
        // resolved == baseline again, no bookkeeping in between.
        let _ = state
            .apply(edit("music", &[("dvla", &[4]), ("gebg", &[0, 0])]), &table)
            .unwrap();
        let _ = state.apply(select_preset("music", None), &table).unwrap();
        let music = state.selected();
        assert_eq!(music.content, music.baseline);

        // The preset counterpart, over the preset-carried params.
        let _ = state
            .apply(
                Command::EditEqPreset {
                    id: rich(),
                    name: None,
                    params: [("iebt".to_string(), vec![9_i16])].into(),
                },
                &table,
            )
            .unwrap();
        let rich_preset = state.eq_preset(&rich()).unwrap();
        assert_eq!(rich_preset.content.params["iebt"], vec![9, 95, -55, -235]);
        assert_eq!(
            rich_preset.baseline.params["iebt"],
            vec![67, 95, -55, -235],
            "the preset baseline holds beneath the edit"
        );
    }

    /// `reset_eq_preset` restores the baseline and batches iff the
    /// selected profile selects the preset.
    #[test]
    fn reset_eq_preset_restores_the_baseline_and_batches_when_live() {
        let mut state = State::new_from_defaults(&defaults());
        let rich_id = PresetId("rich".into());
        let edit_rich = Command::EditEqPreset {
            name: None,
            id: rich_id.clone(),
            params: [("iebt".to_string(), vec![100_i16])].into(),
        };
        let reset_rich = Command::ResetEqPreset {
            id: rich_id.clone(),
            only: None,
        };

        // Not selected anywhere: reset persists, engine silent.
        let _ = state.apply(edit_rich.clone(), &defs()).unwrap();
        let diff = state.apply(reset_rich.clone(), &defs()).unwrap();
        assert!(!diff.is_empty());
        assert_eq!(diff.params, None);
        assert_eq!(
            state.eq_preset(&rich_id).unwrap().content.params["iebt"],
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
                    only: None,
                },
                &defs(),
            ),
            Err(ValidationError::UnknownEqPreset("ghost".into())),
        );
    }
}
