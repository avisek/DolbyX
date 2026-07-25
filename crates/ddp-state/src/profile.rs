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
    /// The EQ selection this profile's own `config.toml` row states —
    /// the persisted tri-state (ADR-0007): `None` = nothing stated
    /// (inherit what resolves beneath — always `None` until
    /// `defaults.toml` rows may ship selections, issue #26 part B),
    /// `Some(None)` = explicit no-preset (the reserved `"none"`
    /// sentinel on disk, JSON `null` on the wire), `Some(Some(id))` =
    /// select. Deletion fallback pins `Some(None)` so a delete can
    /// never activate the selection beneath (ADR-0003).
    #[expect(
        clippy::option_option,
        reason = "persisted tri-state: unstated ≠ explicit none ≠ id (ADR-0007)"
    )]
    pub selection_override: Option<Option<PresetId>>,
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
    /// The EQ overlay in effect — the resolved selection: the override
    /// when stated, else what resolves beneath (`None` until
    /// `defaults.toml` rows may ship selections, issue #26 part B).
    /// `None` ⇒ the profile's own EQ params apply (factory profiles
    /// ship no selection — first-run parity with the original's
    /// `ieon = 0`).
    #[must_use]
    pub fn selected_eq_preset(&self) -> Option<&PresetId> {
        self.selection_override.as_ref().and_then(Option::as_ref)
    }

    /// Splices `values` over the head of the full-length array `name`
    /// holds — the overlay rule for band arrays shorter than the
    /// engine-capacity allocation.
    ///
    /// # Panics
    ///
    /// When `name` is not a seeded param or `values` exceeds its
    /// allocation — callers validate against `ParameterDef` first.
    pub fn splice(&mut self, name: &str, values: &[i16]) {
        crate::param_def::splice_head(&mut self.params, name, values);
    }
}
