//! `EqPreset` — an optional EQ overlay, global across profiles,
//! carrying the nine preset-carried params (ADR-0003).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Stable string id of an EQ preset (`"rich"`, `"user_91c2"`) —
/// reorder-safe, TOML-clean.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PresetId(pub String);

/// An EQ preset's content — its resettable config row (ADR-0007): the
/// preset-carried params, nothing else. As [`crate::ProfileContent`],
/// one shape serves both [`EqPreset::content`] and
/// [`EqPreset::baseline`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PresetContent {
    /// The value of every preset-carried param (`category ∈ {Ieq,
    /// Geq}` — eligibility is derived, never declared), keyed by 4-CC.
    /// Band arrays stay allocated at engine capacity, as in
    /// [`crate::ProfileContent`].
    pub params: HashMap<String, Vec<i16>>,
}

/// One EQ preset, complete: `content.params` fully resolved through
/// the `[eq_preset]` cascade at load, so a selected preset shadows the
/// profile's own EQ params *entirely* — never half-applies (ADR-0003).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EqPreset {
    /// Stable id (`"rich"`, `"user_91c2"`).
    pub id: PresetId,
    /// User-editable display name (factory names ship in
    /// `defaults.toml`) — a label, never content.
    pub name: String,
    /// Whether the id appears in `defaults.toml` — derived at load,
    /// never stored; factory items reset instead of delete/rename.
    pub is_factory: bool,
    /// The resolved content.
    pub content: PresetContent,
    /// What resolves beneath this preset's own `config.toml` row — as
    /// [`crate::Profile::baseline`], over the preset-carried params.
    pub baseline: PresetContent,
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
        crate::param_def::splice_head(&mut self.content.params, name, values);
    }
}
