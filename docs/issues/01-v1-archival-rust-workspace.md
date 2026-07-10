# Slice 01 — v1 archival + Cargo workspace + Justfile + Rust CI

**Goal.** The v1 tree is archived at tag `v1` and deleted; a fresh Cargo
workspace with the full crate skeleton compiles, lints, and passes CI on
Linux + Windows.

**Blocked by:** none — can start immediately.
**Mode:** HITL — module layout warrants a human review pass before the
first commit lands on `main`.
**Type:** pure scaffolding — no user-visible behavior, `/tdd` does not
apply. One-shot setup.

## What to build

**v1 archival.** Tag the pre-v2 tree `v1`, then delete v1 in one commit:

- Relocate first: `arm/lib/libdseffect.so` + `ds1-default.xml` →
  `vendored/`; `arm/stubs/` (+ the stub-build Makefile bits) →
  `tools/ddp_probe/`, fixing the probe's `ARMDIR` and README paths so it
  builds standalone.
- Delete: `daemon/`, the vanilla-JS `ui/`, `windows/vst/`, `arm/`, the v1
  docs (`docs/ARCHITECTURE.md`, `docs/CROSS_PLATFORM_PLAN.md`,
  `docs/DDP_Reverse_Engineering_Analysis.md` — superseded by `docs/ddp/`),
  the v1 scripts (`start-dolbyx.bat`, `setup_wsl.sh`), and the `linux/` /
  `macos/` / `nix/` `.gitkeep` placeholders.
- Keep: `tools/ddp_probe/` and `samples/` — active tooling, not v1 code.
- Rewrite the root README for v2 (quickstart for end users +
  contributors). Reference the old tree via `git show v1:<path>`.

**Workspace.** New Cargo workspace with the crate skeleton from the epic's
crate map (`ddp-engine`, `ddp-state`, `ddp-persistence`, `ddp-daemon`,
`ddp-engine-arm`, `ddp-vst-windows`, `ddp-lv2-linux` — stub `lib.rs` /
`main.rs` contents, compiling). `rust-toolchain.toml` pinning a stable
Rust. `[workspace.lints]` per the epic's code-quality standards; every
crate opts in.

**Justfile.** Top-level recipes: `dev`, `build-release`, `lint`, `test`
(recipes may shell out to not-yet-existing steps behind clear TODOs, but
`lint` and `test` must run green now).

**CI.** GitHub Actions on Linux + Windows: `cargo check`, `cargo test`,
`cargo clippy --workspace --all-targets -- -D warnings` (with
`RUSTFLAGS=-D warnings`), `cargo fmt --check`.

## Acceptance criteria

- [ ] v1 tagged `v1`; v1 code deleted in one commit; relocations done
- [ ] `make -C tools/ddp_probe` builds standalone after the stub move
- [ ] Cargo workspace + crate skeleton compiles (`cargo check` clean)
- [ ] `just lint` and `just test` run green end-to-end
- [ ] GitHub Actions green on Linux + Windows runners
- [ ] Root README rewritten for v2
- [ ] All linters / formatters clean

## References

- Epic: crate map, code-quality standards
- `docs/adr/0001-rust-daemon.md`
- `docs/adr/0009-bundle-libdseffect-so.md` — why `vendored/`
