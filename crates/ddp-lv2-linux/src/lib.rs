//! Thin LV2 plugin for Linux hosts (PipeWire): audio over the
//! `/run/dolbyx/dolbyx.sock` `AF_UNIX` socket to the daemon.
//!
//! Skeleton — the plugin lands in Slice 21
//! ([#29](https://github.com/avisek/DolbyX/issues/29)).

#![forbid(unsafe_code)]
