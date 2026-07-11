//! Thin VST2 plugin for Windows hosts (EqualizerAPO): audio over the
//! `\\.\pipe\DolbyX` named pipe to the daemon.
//!
//! Skeleton — the plugin lands in Slice 13
//! ([#21](https://github.com/avisek/DolbyX/issues/21)).

#![forbid(unsafe_code)]
