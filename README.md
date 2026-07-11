# DolbyX

Run Android's legendary **Dolby Digital Plus** audio effect on your PC —
system-wide, on all audio. The original ARM DSP binary (`libdseffect.so`)
runs under QEMU emulation with zero quality compromise:

- **Spatial audio** — HRTF-based headphone virtualizer with crossfeed
- **Intelligent EQ** — content-adaptive spectral shaping
- **Surround upmix** — stereo/mono → virtual 5.1/7.1
- **Dialog enhancement** — vocal isolation and boost
- **Dynamic range control** — fatigue-free listening for hours

## Status: v2 rebuild in progress

`main` carries the ground-up v2 rearchitecture
([epic #8](https://github.com/avisek/DolbyX/issues/8)): a Rust daemon
(HTTP/WS server + audio-plugin IPC + engine supervision in one binary), a
Solid.js Web UI, and thin platform plugins (VST2 for Windows, LV2 for
Linux) — faithful to the original DDP's sound, look, and feel, then
extending it with custom profiles, custom EQ presets, and every engine
parameter exposed.

**To use DolbyX today**, check out the working v1 (Windows + EqualizerAPO
+ WSL2) and follow its README:

```bash
git checkout v1
```

Or browse any v1 file in place: `git show v1:daemon/main.c`.

| Version | Platform                        | Status      |
| ------- | ------------------------------- | ----------- |
| v1      | Windows (EqualizerAPO + WSL2)   | Archived    |
| v2.0    | Windows + Linux, Web UI         | In progress |
| v2.1    | Native emulation (drops WSL2)   | Planned     |
| v3.0    | macOS (AudioServerPlugin)       | Planned     |

## Development

Prerequisites: [rustup](https://rustup.rs) (the toolchain is pinned by
`rust-toolchain.toml`), [just](https://just.systems), Node ≥ 22 +
[pnpm](https://pnpm.io), and `cargo install cargo-watch` (for `just
dev`). For the probe harness only: `apt install gcc-arm-linux-gnueabihf
g++-arm-linux-gnueabihf qemu-user-static`.

```bash
just lint    # cargo fmt --check + clippy (-D warnings) + UI lint
just test    # cargo test --workspace + UI tests
just dev     # daemon + UI dev loop with hot reload
```

Reading order for contributors:

1. [Epic #8](https://github.com/avisek/DolbyX/issues/8) — architecture,
   cross-slice invariants, wire protocol, slice index
2. [`CONTEXT.md`](CONTEXT.md) — the project glossary; use its terms exactly
3. [`docs/adr/`](docs/adr/) — one decision per file
4. [`docs/ddp/`](docs/ddp/README.md) — the complete `libdseffect.so`
   reverse engineering

## Layout

```
crates/
├── ddp-engine/        Engine trait + backends (stub, QEMU)
├── ddp-state/         pure state model — profiles, EQ presets, params (no I/O)
├── ddp-persistence/   TOML load/save + file watcher
├── ddp-daemon/        the daemon binary — HTTP/WS + plugin IPC + supervision
├── ddp-engine-arm/    the engine shim — ARMv7, dlopens libdseffect.so
├── ddp-vst-windows/   thin VST2 plugin (EqualizerAPO)
└── ddp-lv2-linux/     thin LV2 plugin (PipeWire)
ui/                    Solid.js Web UI — independent pnpm project
docs/ddp/              engine reverse engineering — the reference
docs/adr/              architecture decision records
tools/ddp_probe/       evidence harness proving every docs/ddp claim
vendored/              libdseffect.so v2.0.4.0 + ds1-default.xml (ADR-0009)
samples/               test audio
decompiled/            original DDP app artifacts (RE source material)
```

## License

DolbyX is for personal and educational use. It drives the proprietary
Dolby `libdseffect.so`, bundled for ease of install
([ADR-0009](docs/adr/0009-bundle-libdseffect-so.md)); everything around it
is original work.
