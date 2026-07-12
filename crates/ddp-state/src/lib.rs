//! Pure state model: profiles, EQ presets, parameter metadata — no I/O.
//!
//! The `ParameterDef` table (Slice 03, [#11](https://github.com/avisek/DolbyX/issues/11))
//! lives in [`param_def`]; `State` + the profile model in [`state`] /
//! [`profile`] (Slices 04 [#12](https://github.com/avisek/DolbyX/issues/12)
//! and 10 [#18](https://github.com/avisek/DolbyX/issues/18)).

#![forbid(unsafe_code)]

pub mod param_def;
pub mod preset;
pub mod profile;
pub mod state;

pub use param_def::{
    ParamAccess, ParamCategory, ParamKind, ParameterDef, ParseError, base_params, lookup, parse,
};
pub use preset::PresetId;
pub use profile::{Profile, ProfileId};
pub use state::{Command, Defaults, State, StateDiff, ValidationError, validate_write};
