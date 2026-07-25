//! `EqPreset` — an optional EQ overlay, global across profiles,
//! carrying the nine preset-carried params (ADR-0003).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::param_def::ParameterDef;

/// Stable string id of an EQ preset (`"rich"`, `"user_91c2"`) —
/// reorder-safe, TOML-clean.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PresetId(pub String);

/// One EQ preset, complete: `params` holds every preset-carried param
/// (`category ∈ {Ieq, Geq}` — eligibility is derived, never declared)
/// fully resolved through the `[eq_preset]` cascade at load, so a
/// selected preset shadows the profile's own EQ params *entirely* —
/// never half-applies (ADR-0003). Band arrays stay allocated at engine
/// capacity, as in [`crate::profile::Profile`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EqPreset {
    /// Stable id (`"rich"`, `"user_91c2"`).
    pub id: PresetId,
    /// User-editable display name (factory names ship in `defaults.toml`).
    pub name: String,
    /// Whether the id appears in `defaults.toml` — derived at load,
    /// never stored; factory items reset instead of delete/rename.
    pub is_factory: bool,
    /// The resolved value of every preset-carried param, keyed by 4-CC.
    pub params: HashMap<String, Vec<i16>>,
    /// What resolves beneath this preset's own `config.toml` overrides
    /// (factory layers + `config.toml` shared) — `reset_eq_preset`'s
    /// target and the write-back divergence base.
    pub baseline: HashMap<String, Vec<i16>>,
}

impl EqPreset {
    /// Splices `values` over the head of the full-length array `name`
    /// holds — the overlay rule for band arrays shorter than the
    /// engine-capacity allocation.
    ///
    /// # Panics
    ///
    /// When `name` is not a preset-carried param or `values` exceeds
    /// its allocation — callers validate against `ParameterDef` first.
    pub fn splice(&mut self, name: &str, values: &[i16]) {
        crate::param_def::splice_head(&mut self.params, name, values);
    }

    /// The snapshot's per-item `overridden` list (ADR-0005): the
    /// preset-carried params diverging from what resolves beneath the
    /// preset's `config.toml` row, in `defs` table order; never `name`.
    /// Reset's dual: exactly what a whole-item `reset_eq_preset` would
    /// clear.
    #[must_use]
    pub fn overridden(&self, defs: &[ParameterDef]) -> Vec<String> {
        crate::param_def::diverging(&self.params, &self.baseline, defs)
    }
}
