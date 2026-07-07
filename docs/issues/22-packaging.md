# Slice 22 — Release packaging

**Goal.** One command produces installable release artifacts for Windows
and Linux: daemon + UI + engine + plugins + TOMLs laid out per ADR-0009,
registered as a system service, with a quickstart a stranger can follow.
Completes v2.0.

**Blocked by:** Slices 13, 21 (packages everything).
**Mode:** HITL — install smoke on real machines.

## What to build

**Artifact layout**
(ADR-0009 — `docs/adr/0009-bundle-libdseffect-so.md` — bundling
`libdseffect.so` is a deliberate ease-of-install > legal-cleanliness
tradeoff; personal-use distribution, README explicit that DolbyX wraps a
third-party proprietary binary; legal review deferred unless
commercialized):

```
dolbyx/
├── dolbyx-daemon          # Rust binary
├── index.html             # Vite singlefile UI build (disk-served)
├── dolbyx-engine-arm      # ARM engine binary
├── libdseffect.so         # bundled from vendored/
├── parameters.toml        # AK metadata (runtime-loaded)
├── defaults.toml          # factory profiles + EQ presets (user-inspectable)
└── README.txt
```

Plus platform extras: `DolbyX.dll` (Windows), `libdolbyx.lv2` (Linux).
The daemon resolves `libdseffect.so` and both TOMLs from its own
directory.

**System-level install — no per-user mode:**

- **Linux**: systemd unit with `RuntimeDirectory=dolbyx` (owns
  `/run/dolbyx/` creation + ACLs so user-session audio hosts can reach
  the socket); state dir `/var/lib/dolbyx/`; optional log
  `/var/log/dolbyx/dolbyx.log` (rotating, 7-day retention — finish the
  epic's Logging file target here). `scripts/package-linux.sh`.
- **Windows**: register the daemon as a Windows service;
  `%PROGRAMDATA%\DolbyX\` state + logs; pipe ACLs so user-session hosts
  connect; `scripts/package-windows.ps1` (bundle `setup-windows.bat` from
  Slice 12).
- **`scripts/build-release.sh`** / `just build-release` finalized: UI
  singlefile build → release cargo build (+ ARM engine + plugins) →
  assemble the layout above.
- **`flake.nix`** *(optional / nice-to-have)*: Nix dev shell + NixOS
  module wrapping the systemd unit.
- **Docs**: root README quickstart (end users + contributors), install
  docs per platform (EqualizerAPO steps from Slice 13, PipeWire config
  from Slice 21), `README.txt` inside the artifact.

## Behaviors to test

1. [ ] `just build-release` assembles the full layout on Linux; the
       artifact runs from a scratch directory (no repo checkout).
2. [ ] Linux: systemd unit installs, starts on boot, socket ACLs let a
       user-session plugin connect; logs rotate.
3. [ ] Windows: service installs + auto-starts; VST in EqualizerAPO
       connects to the service-hosted pipe; UI reachable.
4. [ ] Fresh-machine smoke (VM or clean prefix): install → play music →
       authentic Music-profile sound with zero manual config (first-run
       semantics from Slice 10).
5. [ ] Uninstall leaves no strays (state dir removal documented as a
       choice).
6. [ ] README quickstarts verified by following them literally.

## Tracer bullet

`just build-release` on Linux → run the artifact from `/tmp/dolbyx-test`
→ daemon starts, serves UI, spawns engine, first-run `config.toml`
created empty.

**Mock policy.** Nothing mocked — this slice is about the real install
surface.

## References

- ADR-0009 (`docs/adr/0009-bundle-libdseffect-so.md`)
- Epic: persistence paths, logging targets
- Slices 12, 13, 21 — platform pieces being packaged
