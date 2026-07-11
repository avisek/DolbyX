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

_ui-deps:
    @test -d ui/node_modules || pnpm -C ui install
