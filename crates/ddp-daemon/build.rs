//! Ships the runtime TOMLs beside the daemon binary: copies
//! `parameters.toml` + `defaults.toml` into the target profile directory
//! on every build. (`parameters.engine.toml` is a repo-only CI artifact,
//! never shipped.)

#![forbid(unsafe_code)]

use std::path::PathBuf;

fn main() {
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("cargo sets OUT_DIR"));
    // OUT_DIR = target/<profile>/build/<pkg>-<hash>/out; the binary lands
    // three levels up, in target/<profile>/.
    let bin_dir = out_dir
        .ancestors()
        .nth(3)
        .expect("OUT_DIR is at least four levels deep");
    for shipped in ["parameters.toml", "defaults.toml"] {
        println!("cargo::rerun-if-changed={shipped}");
        std::fs::copy(shipped, bin_dir.join(shipped))
            .unwrap_or_else(|e| panic!("copy {shipped} beside the daemon binary: {e}"));
    }
}
