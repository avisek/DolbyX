//! `Profile` — the canonical persistence unit: home for every
//! non-readonly AK param, plus an optional selected EQ preset.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::preset::PresetId;

/// Stable string id of a profile (`"music"`, `"user_a3f1"`) —
/// reorder-safe, TOML-clean.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProfileId(pub String);

/// One profile, complete: `params` holds every writable param
/// (Settable + Experimental) fully resolved through the cascade at
/// load, so a profile switch pushes one atomic `set_params` batch with
/// no per-param fallback (ADR-0007). Band arrays stay allocated at
/// engine capacity (`ParameterDef.length`); the effective count is the
/// group's `*nb` value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Profile {
    /// Stable id (`"music"`, `"user_a3f1"`).
    pub id: ProfileId,
    /// User-editable display name (factory names ship in `defaults.toml`).
    pub name: String,
    /// The EQ overlay in effect; `None` ⇒ the profile's own EQ params
    /// apply (factory profiles ship `None` — first-run parity with the
    /// original's `ieon = 0`).
    pub selected_eq_preset: Option<PresetId>,
    /// Whether the id appears in `defaults.toml` — derived at load,
    /// never stored; factory items reset instead of delete/rename.
    pub is_factory: bool,
    /// The resolved value of every writable param, keyed by 4-CC.
    pub params: HashMap<String, Vec<i16>>,
    /// What resolves beneath this profile's own `config.toml` overrides
    /// (factory layers + `config.toml` shared) — `reset_profile`'s
    /// target and the write-back divergence base.
    pub baseline: HashMap<String, Vec<i16>>,
}

impl Profile {
    /// Splices `values` over the head of the full-length array `name`
    /// holds — the overlay rule for band arrays shorter than the
    /// engine-capacity allocation.
    ///
    /// # Panics
    ///
    /// When `name` is not a seeded param or `values` exceeds its
    /// allocation — callers validate against `ParameterDef` first.
    pub fn splice(&mut self, name: &str, values: &[i16]) {
        let current = self
            .params
            .get_mut(name)
            .unwrap_or_else(|| panic!("`{name}` is not a writable param"));
        current[..values.len()].copy_from_slice(values);
    }
}
