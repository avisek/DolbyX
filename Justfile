# DolbyX dev commands — `just --list` for a summary.

# Daemon + UI dev loop with hot reload
dev:
    @echo "TODO(Slice 02, #10): cargo watch daemon --ui ui/dev.html + pnpm -C ui dev"

# Optimized build of every crate
build-release:
    cargo build --workspace --release
    @echo "TODO(Slice 22, #30): platform packaging"

# Format check + clippy, exactly as CI runs them
lint:
    cargo fmt --all --check
    cargo clippy --workspace --all-targets -- -D warnings

# Full test suite
test:
    cargo test --workspace
