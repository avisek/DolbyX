# DolbyX dev commands — `just --list` for a summary.

# Daemon + UI dev loop with hot reload, against the real engine
dev: (_dev "")

# Vite serves all interfaces (issue #72); the daemon side stays gated on
# the UI's LAN access toggle (ADR-0012) — no special-casing. While up,
# :5173 serves workspace source to the whole LAN. WSL2 needs a
# Windows-side bridge — docs/windows.md.
# `dev`, phone-reachable — flip LAN access on in the UI
dev-lan: (_dev "--host 0.0.0.0")

_dev vite_flags: _ui-deps stage-engine
    ui/node_modules/.bin/concurrently --kill-others --names daemon,ui --prefix-colors auto \
        "cargo watch -w crates -w Cargo.toml -w Cargo.lock -x 'run -p ddp-daemon -- --ui ui/dev.html --socket-path target/debug/dolbyx.sock'" \
        "pnpm -C ui dev {{vite_flags}}"

# Stage the ARM engine (shim + libdseffect.so + stubs) beside the debug daemon binary
stage-engine:
    scripts/stage-engine.sh target/debug

# Optimized build of every crate + singlefile UI beside the daemon binary
build-release: _ui-deps
    pnpm -C ui build
    cargo build --workspace --release
    cp ui/dist/index.html target/release/index.html
    @echo "TODO(Slice 22, #30): platform packaging"

# Format check + clippy + UI lint, exactly as CI runs them
lint: _ui-deps
    cargo fmt --all --check
    cargo clippy --workspace --all-targets -- -D warnings
    pnpm -C ui lint

# Full test suite
test: _ui-deps
    cargo test --workspace
    pnpm -C ui test

# Playwright E2E: real browser against the real daemon + engine (issue #17)
e2e: _ui-deps stage-engine
    cargo build -p ddp-daemon
    pnpm -C ui exec playwright install chromium
    pnpm -C ui run e2e

# Cross-build the native Windows daemon + VST plugin, staging everything
# into target/windows/ (apt install gcc-mingw-w64-x86-64); run the printed
# line from Windows or straight from this WSL shell — see docs/windows.md
windows-build: _ui-deps
    rustup target add x86_64-pc-windows-gnu
    pnpm -C ui build
    cargo build -p ddp-daemon -p ddp-vst-windows --target x86_64-pc-windows-gnu --release
    mkdir -p target/windows
    cp target/x86_64-pc-windows-gnu/release/ddp-daemon.exe \
       target/x86_64-pc-windows-gnu/release/parameters.toml \
       target/x86_64-pc-windows-gnu/release/defaults.toml \
       ui/dist/index.html target/windows/
    cp target/x86_64-pc-windows-gnu/release/ddp_vst_windows.dll target/windows/DolbyX.dll
    scripts/stage-engine.sh target/windows/engine
    @echo "Staged. Run the Windows daemon:"
    @echo "  target/windows/ddp-daemon.exe --engine-dir $(realpath target/windows/engine)"
    @echo "VST plugin for EqualizerAPO: target/windows/DolbyX.dll (docs/windows.md)"

# Cross-compile the ARMv7 engine shim (rustup target + gcc-arm-linux-gnueabihf linker)
arm-build:
    rustup target add armv7-unknown-linux-gnueabihf
    cargo build -p ddp-engine-arm --target armv7-unknown-linux-gnueabihf --release

# apt install gcc-arm-linux-gnueabihf g++-arm-linux-gnueabihf qemu-user-static
# Integration tests against the real libdseffect.so under qemu-arm-static
# (the suites stage the engine themselves via scripts/stage-engine.sh)
qemu-test:
    cargo test -p ddp-engine --features qemu
    cargo test -p ddp-daemon --features qemu

# Regenerate parameters.engine.toml from the live engine (probe dumps)
param-twin:
    mkdir -p target/param-twin
    make -sC tools/ddp_probe dump-tree > target/param-twin/tree.txt
    make -sC tools/ddp_probe dump-defaults > target/param-twin/defaults.txt
    make -sC tools/ddp_probe dump-docs > target/param-twin/docs.txt
    cargo run -p ddp-daemon --bin gen_param_twin -- \
        target/param-twin/tree.txt target/param-twin/defaults.txt \
        target/param-twin/docs.txt crates/ddp-daemon/parameters.engine.toml

_ui-deps:
    @test -d ui/node_modules || pnpm -C ui install
