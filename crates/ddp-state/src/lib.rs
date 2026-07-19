//! Pure state model: profiles, EQ presets, parameter metadata — no I/O.
//!
//! The `ParameterDef` table (Slice 03, [#11](https://github.com/avisek/DolbyX/issues/11))
//! lives in [`param_def`]; `State` + the profile model in [`state`] /
//! [`profile`] (Slices 04 [#12](https://github.com/avisek/DolbyX/issues/12)
//! and 10 [#18](https://github.com/avisek/DolbyX/issues/18)); the EQ
//! preset overlay in [`preset`] (Slice 15,
//! [#23](https://github.com/avisek/DolbyX/issues/23)); the
//! i16 ↔ display-unit reference in [`conversion`] (Slice 14,
//! [#22](https://github.com/avisek/DolbyX/issues/22)).

#![forbid(unsafe_code)]

pub mod conversion;
pub mod param_def;
pub mod preset;
pub mod profile;
pub mod state;

pub use conversion::{display_to_raw, raw_to_display};
pub use param_def::{
    ParamAccess, ParamCategory, ParamKind, ParameterDef, ParseError, base_eq_params, base_params,
    lookup, parse,
};
pub use preset::{EqPreset, PresetId};
pub use profile::{Profile, ProfileId};
pub use state::{
    Command, Defaults, ItemKind, State, StateDiff, ValidationError, validate_eq_preset_write,
    validate_write,
};
