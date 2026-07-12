#!/usr/bin/env bash
# Stages the ARM engine — shim + libdseffect.so + Android stubs — into
# the given directory: what `QemuBackend::start` takes, and what must
# sit beside the daemon binary in production. Shared by `just
# stage-engine` (dev, target/debug) and `ddp_engine::test_support`
# (test runs, target/qemu-stage).
set -euo pipefail

dest=${1:?usage: stage-engine.sh <dest-dir>}
cd -- "$(dirname -- "$0")/.."

rustup target add armv7-unknown-linux-gnueabihf >/dev/null
cargo build -p ddp-engine-arm --target armv7-unknown-linux-gnueabihf --release
make -sC tools/ddp_probe stage

mkdir -p -- "$dest"
# -L: the probe's lib dir holds sysroot symlinks; stage real files.
cp -L tools/ddp_probe/build/lib/*.so -- "$dest"/
cp target/armv7-unknown-linux-gnueabihf/release/ddp-engine-arm -- "$dest"/
