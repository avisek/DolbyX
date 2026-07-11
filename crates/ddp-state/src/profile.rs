//! Profile identity. The full `Profile` struct lands in Slice 10
//! ([#18](https://github.com/avisek/DolbyX/issues/18)).

use serde::{Deserialize, Serialize};

/// Stable string id of a profile (`"music"`, `"user_a3f1"`) —
/// reorder-safe, TOML-clean.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProfileId(pub String);
