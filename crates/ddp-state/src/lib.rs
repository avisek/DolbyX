//! Pure state model: profiles, EQ presets, parameter metadata — no I/O.
//!
//! The `ParameterDef` table (Slice 03, [#11](https://github.com/avisek/DolbyX/issues/11))
//! lives in [`param_def`]; `State` lands in Slice 04
//! ([#12](https://github.com/avisek/DolbyX/issues/12)).

#![forbid(unsafe_code)]

pub mod param_def;

pub use param_def::{
    ParamAccess, ParamCategory, ParamKind, ParameterDef, ParseError, lookup, parse,
};
