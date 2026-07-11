//! Ships the runtime TOMLs beside the daemon binary: copies
//! `parameters.toml` into the target profile directory on every build.
//! (`defaults.toml` joins in Slice 10,
//! [#18](https://github.com/avisek/DolbyX/issues/18);
//! `parameters.engine.toml` is a repo-only CI artifact, never shipped.)

#![forbid(unsafe_code)]

use std::path::PathBuf;

fn main() {
    println!("cargo::rerun-if-changed=parameters.toml");
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("cargo sets OUT_DIR"));
    // OUT_DIR = target/<profile>/build/<pkg>-<hash>/out; the binary lands
    // three levels up, in target/<profile>/.
    let bin_dir = out_dir
        .ancestors()
        .nth(3)
        .expect("OUT_DIR is at least four levels deep");
    std::fs::copy("parameters.toml", bin_dir.join("parameters.toml"))
        .expect("copy parameters.toml beside the daemon binary");
}
