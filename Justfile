# DolbyX dev commands — `just --list` for a summary.

# Daemon + UI dev loop with hot reload
dev: _ui-deps
    ui/node_modules/.bin/concurrently --kill-others --names daemon,ui --prefix-colors auto \
        "cargo watch -w crates -w Cargo.toml -w Cargo.lock -x 'run -p ddp-daemon -- --ui ui/dev.html'" \
        "pnpm -C ui dev"

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

# Cross-compile the ARMv7 engine shim (rustup target + gcc-arm-linux-gnueabihf linker)
arm-build:
    rustup target add armv7-unknown-linux-gnueabihf
    cargo build -p ddp-engine-arm --target armv7-unknown-linux-gnueabihf --release

# apt install gcc-arm-linux-gnueabihf g++-arm-linux-gnueabihf qemu-user-static
# Engine integration tests — real libdseffect.so under qemu-arm-static
qemu-test: arm-build
    cargo test -p ddp-engine --features qemu

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
