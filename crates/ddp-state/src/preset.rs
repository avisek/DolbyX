//! EQ preset identity. The full `EqPreset` struct lands in Slice 15
//! ([#23](https://github.com/avisek/DolbyX/issues/23)).

use serde::{Deserialize, Serialize};

/// Stable string id of an EQ preset (`"rich"`, `"user_91c2"`) —
/// reorder-safe, TOML-clean.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PresetId(pub String);
