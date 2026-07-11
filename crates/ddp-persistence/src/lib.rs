//! TOML overlay persistence: defaults/config cascade, debounced
//! write-back, file watcher (ADR-0007).
//!
//! Skeleton — root keys land in Slice 04
//! ([#12](https://github.com/avisek/DolbyX/issues/12)), the cascade in
//! Slice 10 ([#18](https://github.com/avisek/DolbyX/issues/18)).

#![forbid(unsafe_code)]
