# DolbyX Cross-Platform Implementation — Review & Plan

## Spec Review

### Section 1: AF_UNIX Sockets — CRITICAL ISSUE

The spec proposes replacing named pipes with AF_UNIX sockets everywhere.
This has a **showstopper on Windows**: AF_UNIX sockets use the Winsock API
(`ws2_32.dll`), the same network stack that gives audiodg.exe error 10013
(WSAEACCES) on TCP connections. We've empirically proven audiodg.exe cannot
make socket connections of any kind — it's a Windows security boundary on
the audio service account.

**Correction:** Keep named pipes for the Windows VST ↔ daemon audio path
(the only path that crosses from audiodg.exe). Use Unix sockets for:
- Control connections (Web UI WebSocket → daemon)
- Linux/macOS audio plugin ↔ daemon (no audiodg.exe restriction)
- Daemon ↔ processor (same process, any IPC works)

Recommended approach:
```
Windows:
  audiodg.exe → \\.\pipe\DolbyX (named pipe, works with LOCAL SERVICE)
  Browser     → localhost:9876   (HTTP/WebSocket, no restrictions)

Linux/macOS:
  LV2/AU plugin → /tmp/dolbyx.sock (AF_UNIX)
  Browser       → localhost:9876    (HTTP/WebSocket)
```

The daemon abstracts this: it accepts audio from whatever platform transport
is appropriate, and the control path is always HTTP/WebSocket.

### Section 2: dolbyx Daemon — GOOD

Renaming from "bridge" to "dolbyx" makes sense. The daemon's responsibilities
are well-scoped. One addition: on Linux, the daemon can spawn `qemu-arm-static`
directly (no WSL needed), which simplifies the startup significantly.

On macOS with Apple Silicon, QEMU user-mode does NOT work (it translates
Linux syscalls, not macOS syscalls). macOS support requires either:
- Unicorn Engine (embedded ARM emulation — no OS dependency)
- Rosetta 2 won't help (ARM32 → ARM64 is not what Rosetta does)
- Cross-compiled processor using a compatibility layer

This is a real blocker for macOS. The Unicorn Engine path (from our earlier
roadmap) becomes the prerequisite for macOS. Recommend: implement Unicorn
before macOS, or ship macOS as "Linux VM required" initially.

### Section 3: Web UI — GOOD

Spec is solid. Minor improvements:

- esbuild is the right choice for bundling. The `xxd -i` approach for
  embedding is elegant — single binary, no runtime file dependencies.

- Suggest adding: the Web UI should work in **offline mode** — once loaded,
  the page should function even if the HTTP server restarts (WebSocket
  auto-reconnects). This makes the UI resilient to daemon restarts.

- The macOS-specific device selector is well-designed (opt-in, not automatic).

### Section 4: VST Editor Replacement — GOOD

Returning 0×0 from effEditGetRect and using ShellExecute is correct.
One nuance: some VST hosts may not call effEditOpen if the rect is 0×0.
An alternative is to return a small rect (e.g., 200×30) with a single
"Open DolbyX UI" button that launches the browser.

### Section 5: Linux/NixOS — GOOD with NOTES

**LV2 plugin:** Good choice. The LV2 format is simpler than VST and has
first-class PipeWire support. The plugin only needs:
- `lv2:AudioPort` stereo in/out
- Unix socket connection to daemon
- Forward audio, receive processed audio

**PipeWire filter-chain:** This is the right integration point. The config
fragment loads the LV2 as a virtual sink. Users just select it as output.

**NixOS module:** The design is correct. `libdseffect.so` bundled in-repo
means no manual setup. One note: the flake should expose the daemon as a
package too (`packages.x86_64-linux.dolbyx`) for non-NixOS Nix users.

**QEMU on Linux:** No WSL needed — `qemu-arm-static` runs natively.
The daemon just spawns it directly. Much simpler than Windows.

### Section 6: macOS — AMBITIOUS but CORRECT

**AudioServerPlugin:** This is the right approach (not AudioUnit, not
CoreAudio aggregate device — AudioServerPlugin is the proper way to create
a virtual audio device). The complexity is high but the design is sound.

**libASPL:** Good reference. It provides a C++ wrapper around the HAL plugin
API that handles most of the boilerplate.

**nix-darwin module:** The `system.activationScripts` approach for the HAL
driver is the pragmatic solution. The self-cleaning logic (install on
enable=true, remove on enable=false) is the right pattern.

**Blocker: ARM emulation on macOS.** As noted above, QEMU user-mode is
Linux-only. The Unicorn Engine integration should be done before macOS.

### Section 7: Project Structure — GOOD

Clean separation. The `daemon/` directory containing the unified daemon
code is the right abstraction. Suggest adding:

```
daemon/
├── main.c           # Entry point, platform detection
├── processor.c      # QEMU/Unicorn processor management
├── http.c           # HTTP server
├── ws.c             # WebSocket server
├── ipc_unix.c       # AF_UNIX socket server (Linux/macOS)
├── ipc_pipe.c       # Named pipe server (Windows)
└── platform.h       # Platform-specific #ifdefs
```

### Missing from Spec

1. **Unicorn Engine** — needed before macOS (QEMU is Linux-only for
   user-mode). Should be a dedicated phase.

2. **State persistence** — the current DolbyX.ini approach works. Should
   the daemon own persistence (shared across platforms) or keep it
   per-client? Recommend: daemon owns a single `config.json`, Web UI
   reads/writes it via WebSocket.

3. **Multiple simultaneous outputs** — on Linux, PipeWire can have multiple
   sinks. Should DolbyX support processing for multiple outputs?
   Recommend: single processor instance, PipeWire handles routing.

4. **Latency reporting** — LV2 and VST both support reporting processing
   latency. Should document the expected values.

---

## Phased Implementation Plan

### Phase 0: Repo Restructure
**Dependencies:** None
**Effort:** 1 session

- Create new directory layout (`daemon/`, `ui/`, `linux/`, `macos/`, `nix/`)
- Move existing code:
  - `windows/dolbyx-bridge.c` → `daemon/main.c` (refactored)
  - `windows/ddp_vst.c` → `windows/vst/ddp_vst.c`
  - `windows/ddp_ui.c` + `ddp_ui.h` → removed (replaced by Web UI)
- Update build scripts and README
- Commit: clean structure, everything still builds and works

### Phase 1: Daemon HTTP + WebSocket Server
**Dependencies:** Phase 0
**Effort:** 1-2 sessions

- Add minimal HTTP server to daemon (serve single HTML page)
- Add WebSocket server (RFC 6455 handshake + framing)
- Define JSON control protocol:
  - `set_profile`, `set_param`, `set_ieq`, `power`, `get_state`
  - Server→client: `state`, `vis`, `ack`
- Wire WebSocket commands to existing pipe protocol (CMD_SET_PARAM etc.)
- Add visualizer data pump thread (30fps CMD_GET_VIS → WS broadcast)
- Test: curl http://localhost:9876 returns HTML
- Test: wscat connects and can switch profiles

### Phase 2: Web UI — Core Controls
**Dependencies:** Phase 1
**Effort:** 2-3 sessions

- HTML/CSS/JS single page:
  - Dark theme, Dolby cyan accent
  - Profile selector (6 buttons)
  - Power toggle
  - Three toggle rows with amount sliders
  - IEQ mode selector (Open/Rich/Focused/Manual)
  - Reset button
- WebSocket integration (auto-connect, auto-reconnect)
- State sync (load current state on connect)
- Responsive layout (works on any screen size)
- Keyboard accessible (tab navigation, space to toggle)
- Build pipeline: esbuild bundle → xxd → embedded C header
- Test: full control of live audio from browser

### Phase 3: Web UI — Visualizer + EQ
**Dependencies:** Phase 2
**Effort:** 2-3 sessions

- Canvas-based 20-band frequency visualizer
  - Smooth bar animation with decay
  - Gradient fill (dark cyan → bright cyan)
- EQ curve overlay (Catmull-Rom spline)
- Draggable n-band EQ knobs (configurable band count)
  - SVG circle handles with pointer events
  - Real-time graphic EQ update via WebSocket
- IEQ target curve display (when in preset mode)
- CSS transitions for smooth state changes
- Test: drag EQ knobs → hear frequency change in real-time

### Phase 4: VST Simplification + Daemon Polish
**Dependencies:** Phase 2
**Effort:** 1 session

- Remove GDI editor (ddp_ui.c, ddp_ui.h)
- VST effEditOpen → ShellExecute browser to localhost:9876
- VST effEditGetRect → small rect with "Open UI" fallback
- Daemon: config.json persistence (replaces DolbyX.ini)
- Daemon: graceful shutdown, signal handling
- Daemon: auto-detect WSL path on Windows
- Update setup scripts and README

### Phase 5: Linux / NixOS
**Dependencies:** Phase 1 (daemon with HTTP/WS)
**Effort:** 2-3 sessions

- Daemon Linux build (no WSL, direct qemu-arm-static spawn)
- LV2 plugin (`linux/lv2/`):
  - Stereo in/out AudioPort
  - Unix socket connection to daemon
  - Audio buffer forwarding
  - `.ttl` manifest
- PipeWire filter-chain config fragment
- NixOS flake module:
  - `services.dolbyx.enable`
  - systemd user service for daemon
  - PipeWire config via `services.pipewire.extraConfig`
  - Package derivation for daemon + LV2 + ARM binaries
- flake.nix with nixosModules.default + packages
- Test: `nixos-rebuild switch` → DolbyX active on all audio

### Phase 6: Unicorn Engine (Prerequisite for macOS)
**Dependencies:** Phase 1
**Effort:** 3-5 sessions

- Custom ELF loader for libdseffect.so
- ARM stub resolver (android:: symbols → our stubs)
- Unicorn ARM emulator integration
- EffectCreate / Effect_process via Unicorn API
- Performance validation (must be >3× realtime for 48kHz stereo)
- Package as library usable by daemon on all platforms
- This eliminates QEMU dependency for macOS (and optionally Windows)

### Phase 7: macOS
**Dependencies:** Phase 6 (Unicorn) + Phase 1 (daemon)
**Effort:** 3-5 sessions

- AudioServerPlugin virtual device (DolbyX.driver):
  - Stereo output device visible in CoreAudio
  - Captures audio, forwards to daemon via Unix socket
  - Plays processed audio to selected real output
  - Device enumeration endpoint for Web UI
- Web UI: macOS-specific device selector + controls
- nix-darwin module:
  - activationScripts for HAL driver install/remove
  - launchd.agents for daemon
- Manual install docs for non-Nix users
- Test: `darwin-rebuild switch` → DolbyX in Sound preferences

---

## Dependency Graph

```
Phase 0 (restructure)
  ├── Phase 1 (daemon HTTP/WS)
  │     ├── Phase 2 (Web UI core)
  │     │     ├── Phase 3 (visualizer + EQ)
  │     │     └── Phase 4 (VST simplify)
  │     ├── Phase 5 (Linux/NixOS)
  │     └── Phase 6 (Unicorn Engine)
  │           └── Phase 7 (macOS)
  └── (independent)
```

Phases 2-5 can partially overlap. Phase 6 blocks Phase 7 entirely.

---

## Estimated Total

| Phase | Sessions | Calendar |
|-------|----------|----------|
| 0: Restructure | 1 | Day 1 |
| 1: Daemon HTTP/WS | 2 | Days 2-3 |
| 2: Web UI core | 3 | Days 4-6 |
| 3: Visualizer + EQ | 3 | Days 7-9 |
| 4: VST simplify | 1 | Day 10 |
| 5: Linux/NixOS | 3 | Days 11-13 |
| 6: Unicorn | 5 | Days 14-18 |
| 7: macOS | 5 | Days 19-23 |
| **Total** | **~23 sessions** | |

Phases 0-4 (Windows complete + Web UI) can ship as v2.0.
Phase 5 adds Linux, shipping as v2.1.
Phases 6-7 add macOS, shipping as v3.0.
