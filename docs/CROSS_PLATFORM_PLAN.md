# DolbyX Cross-Platform Implementation Plan

## Goal

Expand DolbyX from Windows-only to Windows, Linux, NixOS, and macOS. Unify the
core daemon, replace the VST UI with a Web UI, and keep platform-specific code
minimal.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│  Browser (any platform)                                          │
│  http://localhost:9876                                            │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Web UI — profiles, toggles, EQ, SVG visualizer            │  │
│  └────────────┬───────────────────────────────────────────────┘  │
│               │ WebSocket ws://localhost:9876/ws                  │
└───────────────┼──────────────────────────────────────────────────┘
                │
┌───────────────┼──────────────────────────────────────────────────┐
│  dolbyx daemon                                                    │
│  ┌────────────┴──────────┐  ┌──────────────────────────────┐    │
│  │ HTTP + WebSocket      │  │ Audio IPC                     │    │
│  │ (control, visualizer) │  │ Win: \\.\pipe\DolbyX          │    │
│  │ localhost:9876        │  │ Unix: /tmp/dolbyx.sock         │    │
│  └───────────────────────┘  └──────────────┬───────────────┘    │
│                                             │                    │
│  ┌──────────────────────────────────────────┴──────────────────┐ │
│  │ Processor (QEMU / Unicorn)                                  │ │
│  │ libdseffect.so → 28-node QMF DSP pipeline                  │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

---

## Key Decisions

- The central daemon is renamed from `dolbyx-bridge` to **`dolbyx`**. The
  "bridge" term was Windows-specific. On all platforms it is simply the main
  background process.

- **IPC is hybrid, not unified.** AF_UNIX sockets use Winsock on Windows, which
  audiodg.exe (LOCAL SERVICE) cannot access (error 10013). Named pipes bypass
  Winsock via the kernel filesystem stack. Therefore:

  | Path                  | Windows                        | Linux / macOS                  |
  |-----------------------|--------------------------------|--------------------------------|
  | Plugin → daemon audio | Named pipe `\\.\pipe\DolbyX`   | AF_UNIX `/tmp/dolbyx.sock`     |
  | Browser → daemon ctrl | HTTP/WS `localhost:9876`       | HTTP/WS `localhost:9876`       |

- The Web UI is served by the daemon over HTTP + WebSocket on `localhost:9876`.
  The daemon logs a clickable URL on startup; it does not auto-launch the
  browser.

- The existing VST GDI editor is removed entirely. The VST opens the Web UI in
  the system browser via `ShellExecuteW`.

- The daemon is a **system-level process** for consistency with EqualizerAPO
  (system APO), audiodg.exe (LOCAL SERVICE), PipeWire system graph, and macOS
  AudioServerPlugin (HAL).

  | Platform | Mechanism                                                |
  |----------|----------------------------------------------------------|
  | Windows  | Windows Service (`sc create`, runs as `LOCAL SERVICE`)   |
  | Linux    | systemd system service (`systemd.services`)              |
  | macOS    | LaunchDaemon (`/Library/LaunchDaemons/com.dolbyx.plist`) |

- Config format is **TOML**, parsed with `tomlc17` (single `.c` + `.h`, C99,
  maintained successor to `tomlc99`). System-level paths:

  | Platform | Path                                         |
  |----------|----------------------------------------------|
  | Windows  | `C:\ProgramData\DolbyX\config.toml`          |
  | Linux    | `/var/lib/dolbyx/config.toml`                |
  | macOS    | `/Library/Application Support/DolbyX/config.toml` |

  The daemon owns all reads and writes. Plugins never touch the config directly.

- The project is distributed as a **Nix flake** exposing `nixosModules.default`
  and `darwinModules.default`. No standalone package outputs.

---

## 1. dolbyx Daemon

The unified daemon replaces `dolbyx-bridge.exe`. Responsibilities:

- Accept audio connections from platform-specific plugins
- Manage QEMU/Unicorn processor lifecycle
- Serve Web UI at `GET /`
- WebSocket endpoint for bidirectional control + visualizer streaming
- Own config.toml persistence
- On macOS only: CoreAudio device enumeration endpoints

On startup, print: `DolbyX running → http://localhost:9876`

### Daemon source structure

```
daemon/
├── main.c           # Entry point, platform detection
├── processor.c      # QEMU/Unicorn processor management
├── http.c           # HTTP server (serve embedded HTML)
├── ws.c             # WebSocket server (RFC 6455)
├── ipc_pipe.c       # Named pipe server (Windows)
├── ipc_unix.c       # AF_UNIX socket server (Linux/macOS)
├── config.c         # TOML config read/write (tomlc17)
└── platform.h       # Platform #ifdefs
```

---

## 2. Web UI

### Source structure

Lives in `ui/` as separate HTML, CSS, JS files. Future migration to TypeScript
and SCSS anticipated; build pipeline designed accordingly.

### Build pipeline

`make ui` runs esbuild to bundle and minify all sources into `ui/dist/bundle.html`.
`xxd -i` generates `ui/dist/ui_bundle.h`, included by the daemon as `const char[]`.
The daemon binary is a single self-contained file with no runtime UI dependencies.

### Interface

Single-page layout — profile selector and editor unified on one screen. Dark theme,
Dolby cyan accent. The UI works in offline mode: once loaded, WebSocket auto-reconnects
on daemon restart without requiring a page refresh.

**macOS-specific controls** (absent on Windows and Linux):
- Output device selector (populated from daemon CoreAudio enumeration)
- Button to set DolbyX as system default output (opt-in, not automatic)
- Checkbox for automatic output switching on device plug/unplug (off by default)

Device routing on Windows and Linux is handled transparently by EqualizerAPO and
PipeWire respectively — no device controls needed.

### Visualizer — SVG-Based

The visualizer is a single `<svg>` with layered `<g>` groups:

**`<defs>` block:**
- `<radialGradient id="bg-gradient">` — dark navy center blooming to near-black
- `<pattern id="grid">` — repeating horizontal + vertical lines. Bar widths are
  integer multiples of the grid cell so bars snap naturally
- `<clipPath id="above-curve">` — EQ curve path extended to top edge, forming a
  closed region above the curve for highlight clipping

**`<g>` layer stack (bottom to top):**
1. `background` — gradient rect + grid rect
2. `spectrum` — dim semi-transparent teal `<rect>` per band, heights updated at
   ~30fps from WebSocket visualizer data
3. `spectrum-highlight` — identical rects at full brightness, clipped by
   `above-curve` so only the portion above the EQ curve is bright
4. `eq-curve` — single `<path>` drawn as Catmull-Rom spline through control points
5. `handles` — `<circle>` per EQ band with pointer events for dragging

Bar heights quantized to grid cell height for a discrete "big pixel" appearance.
Updates are immediate snaps, not smooth interpolation.

---

## 3. VST Plugin (Windows Only)

Remove the GDI editor entirely (`ddp_ui.c`, `ddp_ui.h` deleted).

`effEditOpen` launches the Web UI and dismisses the VST popup:

```c
case effEditOpen: {
    ShellExecuteW(NULL, L"open", WEBUI_URL, NULL, NULL, SW_SHOWNORMAL);
    HWND root = GetAncestor((HWND)ptr, GA_ROOT);
    char title[256] = {0};
    GetWindowTextA(root, title, sizeof(title));
    if (strstr(title, "DolbyX") != NULL)
        PostMessage(root, WM_CLOSE, 0, 0);
    return 1;
}
```

`effEditGetRect` returns 0×0. `effFlagsHasEditor` kept so EqualizerAPO shows
"Open Panel". `effEditClose` and `effEditIdle` are no-ops.

Plugin name strings updated to "DolbyX" (dropping "DDP"). Link with `-lshell32`
instead of `-lmsimg32 -lcomdlg32`.

Audio processing continues over named pipe as before.

---

## 4. Linux / NixOS: LV2 Plugin + PipeWire

`libdolbyx.lv2` — minimal LV2 plugin:
- `lv2:AudioPort` stereo in/out
- Connects to daemon via AF_UNIX socket at `/tmp/dolbyx.sock`
- Forwards audio buffers, returns processed audio
- `.ttl` manifest describing ports

PipeWire `filter-chain` config fragment loads the LV2 as a virtual sink and
sets it as system default. PipeWire handles all device switching natively.

On Linux, the daemon spawns `qemu-arm-static` directly (no WSL needed).

### NixOS flake module (`nixosModules.default`)

`libdseffect.so` is bundled in the repository. No manual path configuration.

```nix
{
  inputs.dolbyx.url = "github:avisek/DolbyX";
  imports = [ inputs.dolbyx.nixosModules.default ];
  services.dolbyx.enable = true;
}
```

Declares:
- PipeWire filter-chain config via `services.pipewire.extraConfig`
- `dolbyx` as `systemd.services` (system-level) with `Restart = always`

`nixos-rebuild switch` fully configures the system. No manual steps.

---

## 5. Unicorn Engine (macOS Prerequisite)

QEMU user-mode is a Linux syscall translator — it cannot run on macOS. The
Unicorn Engine uses the same TCG JIT backend as QEMU but provides a bare
CPU emulator API with no OS dependency.

Implementation:
- Custom ELF loader (parse libdseffect.so sections, map into Unicorn memory)
- ARM stub resolver (hook android:: imports to our C++ stubs)
- EffectCreate / Effect_process invocation via Unicorn API
- Performance target: >3× realtime for 48kHz stereo

Unicorn also eliminates the QEMU dependency on Windows (optional improvement)
and enables a future standalone single-DLL VST.

---

## 6. macOS: AudioServerPlugin + nix-darwin

`DolbyX.driver` — macOS AudioServerPlugin virtual audio device, using libASPL
or BGMDriver as reference:
- Appears as stereo output in CoreAudio
- Does NOT set itself as system default automatically (opt-in via Web UI)
- Captures audio → forwards to daemon via AF_UNIX → returns processed audio
- Device enumeration exposed to Web UI for output selection

### nix-darwin flake module (`darwinModules.default`)

```nix
{
  inputs.dolbyx.url = "github:avisek/DolbyX";
  imports = [ inputs.dolbyx.darwinModules.default ];
  services.dolbyx.enable = true;
}
```

HAL driver installation uses `system.activationScripts` with self-cleaning logic:

```nix
system.activationScripts.dolbyx.text = ''
  DEST="/Library/Audio/Plug-Ins/HAL/DolbyX.driver"
  ${if cfg.enable then ''
    if ! diff -rq "${driverPkg}" "$DEST" &>/dev/null 2>&1; then
      rm -rf "$DEST"
      cp -r "${driverPkg}" "$DEST"
      xattr -dr com.apple.quarantine "$DEST"
      launchctl kickstart -k system/com.apple.audio.coreaudiod || true
    fi
  '' else ''
    if [ -d "$DEST" ]; then
      rm -rf "$DEST"
      launchctl kickstart -k system/com.apple.audio.coreaudiod || true
    fi
  ''}
'';
```

Setting `enable = false` and running `darwin-rebuild switch` cleanly removes the
driver. LaunchDaemon for the daemon is fully declarative via `launchd.daemons`.

`darwin-rebuild switch` installs the driver, registers the LaunchDaemon, and
starts the daemon. No code signing required.

Non-Nix manual installation documented in `docs/install-macos.md`.

---

## 7. Project Structure

```
DolbyX/
├── arm/                    # ARM processor + stubs (unchanged)
├── daemon/                 # dolbyx daemon (all platforms)
│   ├── main.c
│   ├── processor.c
│   ├── http.c
│   ├── ws.c
│   ├── ipc_pipe.c          # Windows named pipe
│   ├── ipc_unix.c          # Linux/macOS AF_UNIX
│   ├── config.c            # TOML persistence
│   └── platform.h
├── windows/
│   └── vst/                # VST2 plugin (audio pipe + browser launch)
├── linux/
│   ├── lv2/                # libdolbyx.lv2 + .ttl manifest
│   └── pipewire/           # filter-chain config fragment
├── macos/
│   └── driver/             # DolbyX.driver AudioServerPlugin
├── ui/
│   ├── src/                # HTML, CSS, JS (future: TS, SCSS)
│   ├── dist/               # bundle.html + ui_bundle.h (gitignored)
│   └── build.js            # esbuild bundler
├── docs/
│   ├── ARCHITECTURE.md
│   ├── DDP_Reverse_Engineering_Analysis.md
│   ├── UI_DESIGN.md
│   ├── UI_ARCHITECTURE.md
│   ├── CROSS_PLATFORM_PLAN.md
│   └── install-macos.md
├── nix/
│   ├── nixosModules/       # NixOS flake module
│   └── darwinModules/      # nix-darwin flake module
├── flake.nix
└── flake.lock
```

---

## Out of Scope

- Code signing / notarization
- Unicorn Engine embedding as standalone VST (no bridge)
- Per-profile headphone EQ presets
- Windows ARM support
- Packaging (`.pkg`, `.deb`, `.rpm`, AUR)
- TypeScript / SCSS migration (build pipeline anticipates it)

---

## Phased Implementation

### Phase 0: Repo Restructure
**Dependencies:** None
**Effort:** 1 session

- Create directory layout: `daemon/`, `ui/`, `linux/`, `macos/`, `nix/`
- Move code:
  - `windows/dolbyx-bridge.c` → `daemon/main.c` (refactored)
  - `windows/ddp_vst.c` → `windows/vst/ddp_vst.c`
  - Remove `ddp_ui.c`, `ddp_ui.h` (replaced by Web UI)
- Update build scripts and README
- Everything still builds and works after restructure

### Phase 1: Daemon HTTP + WebSocket Server
**Dependencies:** Phase 0
**Effort:** 2 sessions

- Minimal HTTP server in daemon (~100 lines, serve single page)
- WebSocket server (RFC 6455 handshake + framing, ~200 lines)
- JSON control protocol:
  - Client → Server: `set_profile`, `set_param`, `set_ieq`, `power`, `get_state`
  - Server → Client: `state`, `vis`, `ack`
- Wire WebSocket commands to existing pipe protocol
- Visualizer data pump thread (30fps CMD_GET_VIS → WS broadcast)
- TOML config persistence (tomlc17)

### Phase 2: Web UI — Core Controls
**Dependencies:** Phase 1
**Effort:** 2-3 sessions

- HTML/CSS/JS single page:
  - Profile selector (6 buttons), power toggle
  - Three toggle rows with amount sliders
  - IEQ mode selector (Open/Rich/Focused/Manual)
  - Reset button
- WebSocket auto-connect + auto-reconnect on daemon restart
- State sync (full state load on connect)
- Responsive layout, keyboard accessible
- esbuild → xxd → embedded C header build pipeline

### Phase 3: Web UI — Visualizer + EQ
**Dependencies:** Phase 2
**Effort:** 2-3 sessions

- SVG-based visualizer with layered rendering:
  - Background gradient + grid pattern
  - Spectrum bars (quantized to grid, dim + highlight layers)
  - EQ curve (Catmull-Rom spline `<path>`)
  - Draggable handles (`<circle>` with pointer events)
  - `<clipPath>` intersection highlight
- Configurable n-band EQ (user chooses band count)
- IEQ target curve display (when in preset mode)
- Real-time graphic EQ updates via WebSocket

### Phase 4: VST Simplification
**Dependencies:** Phase 2
**Effort:** 1 session

- Remove GDI editor files
- VST effEditOpen → ShellExecuteW + smart popup dismissal
- effEditGetRect → 0×0
- Update link flags (`-lshell32`, remove `-lmsimg32 -lcomdlg32`)
- Plugin name → "DolbyX"
- Update setup scripts and README

### Phase 5: Linux / NixOS
**Dependencies:** Phase 1
**Effort:** 2-3 sessions

- Daemon Linux build (direct qemu-arm-static, no WSL)
- LV2 plugin: AF_UNIX socket, stereo AudioPort, `.ttl` manifest
- PipeWire filter-chain config fragment
- NixOS flake module: systemd.services, pipewire.extraConfig
- flake.nix with nixosModules.default
- Test: `nixos-rebuild switch` → DolbyX active system-wide

### Phase 6: Unicorn Engine
**Dependencies:** Phase 1
**Effort:** 3-5 sessions

- Custom ELF loader for libdseffect.so
- ARM stub resolver (android:: symbols)
- Unicorn ARM emulator integration
- EffectCreate / Effect_process via Unicorn API
- Performance validation (>3× realtime at 48kHz stereo)
- Packaged as library for daemon on all platforms

### Phase 7: macOS
**Dependencies:** Phase 6 + Phase 1
**Effort:** 3-5 sessions

- AudioServerPlugin virtual device (DolbyX.driver)
- Web UI macOS device selector
- nix-darwin module: activationScripts + launchd.daemons
- Manual install docs (docs/install-macos.md)
- Test: `darwin-rebuild switch` → DolbyX in Sound preferences

---

## Dependency Graph

```
Phase 0 (restructure)
  └── Phase 1 (daemon HTTP/WS)
        ├── Phase 2 (Web UI core)
        │     ├── Phase 3 (visualizer + EQ)
        │     └── Phase 4 (VST simplify)
        ├── Phase 5 (Linux/NixOS)
        └── Phase 6 (Unicorn Engine)
              └── Phase 7 (macOS)
```

Phases 2-5 can partially overlap. Phase 6 fully blocks Phase 7.

---

## Release Plan

| Version | Milestone | Phases |
|---------|-----------|--------|
| v2.0 | Windows + Web UI | 0, 1, 2, 3, 4 |
| v2.1 | Linux / NixOS | 5 |
| v3.0 | macOS | 6, 7 |
