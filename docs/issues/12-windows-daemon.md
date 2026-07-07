# Slice 12 — Windows daemon bring-up (native binary + wsl.exe engine)

**Goal.** The daemon runs as a **native Windows binary**: browser UI on
`localhost:9876`, state in `%PROGRAMDATA%\DolbyX\`, and `QemuBackend`
spawning the ARM engine inside WSL2 via `wsl.exe` stdio — the v1-proven
path. Power + profiles work end-to-end on Windows.

**Blocked by:** Slice 10.
**Mode:** HITL — GitHub Windows runners can't run WSL2; first native run
is debugged manually on the dev machine. (CI still compiles + runs
Stub-backed tests on Windows from Slice 01.)

## What to build

- **`QemuBackend` Windows spawn seam** (from Slice 08): on Windows, spawn
  `wsl.exe -- qemu-arm-static <linux-path-to-ddp-engine-arm>` with piped
  stdio; same framing, same protocol. Handle Windows↔WSL path mapping for
  the engine binary + `libdseffect.so` (installed under a WSL-visible
  location; document the layout).
- **Platform paths**: `%PROGRAMDATA%\DolbyX\config.toml`;
  `defaults.toml` / `parameters.toml` / `index.html` beside the daemon
  binary (unchanged); optional log file location per epic Logging.
- **Graceful shutdown** on Windows: console close handler flushes pending
  writes (Slice 04's SIGTERM analogue — verify it actually fires).
- **`scripts/setup-windows.bat`**: one-time WSL2 setup (until Unicorn
  lands in v2.1) — install/verify WSL distro + `qemu-arm-static`, place
  the engine binary + `libdseffect.so`, print a health check.
- A `just` recipe or script for the Windows cross/native build so the dev
  loop (build on WSL2, run on Windows) is one command.

## Behaviors to test

1. [ ] Daemon builds and starts natively on Windows; `GET /` serves the
       bootstrap-injected UI.
2. [ ] `setup-windows.bat` on a machine with WSL2 produces a working
       engine path; daemon health check passes.
3. [ ] Engine round-trip through `wsl.exe`: power toggle reaches
       `libdseffect.so`; profile switch applies (verify via `readouts` /
       `get_params` — `ver` = 2.0.4.0 proves the real engine).
4. [ ] State persists in `%PROGRAMDATA%\DolbyX\config.toml`; console
       close flushes pending writes.
5. [ ] Engine subprocess kill (`wsl --terminate` or task kill) →
       supervisor respawns transparently.
6. [ ] Browser UI on Windows: power + profile tabs fully working (manual
       smoke).

## Tracer bullet

On Windows: start daemon → open `localhost:9876` → toggle power → restart
daemon → state survived, and the WSL-side engine received
`set_enabled` (log-verified).

**Mock policy.** Real everything; this slice exists to make the Windows
path real.

## References

- Epic: architecture (backend table — Windows row), persistence paths
- ADR-0002 (`docs/adr/0002-backend-agnostic-engine-qemu-default.md`)
- v1's Windows/WSL scripts via `git show v1:scripts/…` for the proven
  spawn incantations
