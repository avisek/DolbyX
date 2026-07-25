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

/// A profile's content — its resettable config row (ADR-0007): the EQ
/// selection plus every writable param. One shape serves both sides of
/// divergence: [`Profile::content`] resolves it through the cascade,
/// [`Profile::baseline`] holds what resolves beneath the row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProfileContent {
    /// The EQ selection — `None` ⇒ the profile's own EQ params apply
    /// (the shipped factory profiles select none — first-run parity
    /// with the original's `ieon = 0`).
    pub selected_eq_preset: Option<PresetId>,
    /// The value of every writable param (Settable + Experimental),
    /// keyed by 4-CC. Band arrays stay allocated at engine capacity
    /// (`ParameterDef.length`); the effective count is the group's
    /// `*nb` value.
    pub params: HashMap<String, Vec<i16>>,
}

/// One profile, complete: `content.params` holds every writable param
/// fully resolved through the cascade at load, so a profile switch
/// pushes one atomic `set_params` batch with no per-param fallback
/// (ADR-0007).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Profile {
    /// Stable id (`"music"`, `"user_a3f1"`).
    pub id: ProfileId,
    /// User-editable display name (factory names ship in
    /// `defaults.toml`) — a label, never content: it neither resets
    /// nor counts toward divergence.
    pub name: String,
    /// Whether the id appears in `defaults.toml` — derived at load,
    /// never stored; factory items reset instead of delete/rename.
    pub is_factory: bool,
    /// The resolved content — what the engine hears and the UI shows.
    pub content: ProfileContent,
    /// What resolves beneath this profile's own `config.toml` row —
    /// Reset's floor, the write law's divergence base, and the
    /// snapshot-shipped input clients derive divergence from
    /// (ADR-0005). Factory rows may ship an EQ selection beneath
    /// (ADR-0007); customs never have one.
    pub baseline: ProfileContent,
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
        crate::param_def::splice_head(&mut self.content.params, name, values);
    }
}
