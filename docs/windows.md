# DolbyX on Windows (v2.0)

The daemon is a **native Windows binary**; only the ARM engine runs
inside WSL2. `ddp-daemon.exe` spawns
`wsl.exe --exec qemu-arm-static … ddp-engine-arm` with piped stdio —
same protocol and framing as the Linux-native spawn
([#20](https://github.com/avisek/DolbyX/issues/20)). WSL2 is a v2.0
requirement only; the v2.1 Unicorn backend drops it.

## Layout

| What                                                          | Where                                             |
| ------------------------------------------------------------- | ------------------------------------------------- |
| `ddp-daemon.exe` + `parameters.toml`, `defaults.toml`, `index.html` | one directory, anywhere on the Windows side |
| `DolbyX.dll` (VST2 plugin)                                     | wherever EqualizerAPO loads it from — see below   |
| Engine: `ddp-engine-arm`, `libdseffect.so`, stub `.so`s       | WSL side: `/opt/dolbyx/engine` (default `--engine-dir`) |
| State                                                          | `%PROGRAMDATA%\DolbyX\config.toml`                |
| Logs                                                           | stdout/stderr under `RUST_LOG`; rotating file lands with Slice 22 ([#30](https://github.com/avisek/DolbyX/issues/30)) |

On Windows `--engine-dir` names a **WSL-side Linux path** — the daemon
hands it to `wsl.exe` verbatim.

## Setup (once)

Run `scripts\setup-windows.bat`. It verifies a bootable default WSL2
distro, installs `qemu-user-static` (apt), copies the engine files
(`engine\` beside the script, else the repo's `target\windows\engine`)
into `/opt/dolbyx/engine`, and health-checks the daemon's qemu
invocation.

Health check, standalone — exit 0 means qemu ran, the shim loaded
`libdseffect.so`, and stdin EOF closed it cleanly:

```
wsl -e sh -c "qemu-arm-static -E LD_LIBRARY_PATH=/opt/dolbyx/engine -L /usr/arm-linux-gnueabihf /opt/dolbyx/engine/ddp-engine-arm < /dev/null"
```

## VST plugin (EqualizerAPO)

`DolbyX.dll` ferries system playback through the daemon's engine
(issue [#21](https://github.com/avisek/DolbyX/issues/21)). Install:

1. Copy `target\windows\DolbyX.dll` somewhere stable, e.g.
   `C:\Program Files\EqualizerAPO\VSTPlugins\DolbyX.dll`.
2. Add one line to `C:\Program Files\EqualizerAPO\config\config.txt`
   (or pick the DLL in the Configuration Editor):

   ```
   VSTPlugin: Library "C:\Program Files\EqualizerAPO\VSTPlugins\DolbyX.dll"
   ```

EqualizerAPO reloads on save — audio flows immediately. Daemon down =
clean pass-through; the plugin reconnects within a second of it
returning. The plugin has no editor: "Open panel" on its config row
opens the Web UI (`http://localhost:9876`).

The plugin is deliberately silent — diagnose from the daemon's logs
(`RUST_LOG=debug`). A daemon on a non-default `--socket-path` is
reachable by setting `DOLBYX_SOCKET_PATH` for the host process.

## Dev loop: build on WSL2, run on Windows

Prerequisite (in WSL): `apt install gcc-mingw-w64-x86-64`.

```bash
just windows-build   # cross-build + stage target/windows/: daemon, DolbyX.dll, TOMLs, UI, engine
```

Run the staged daemon from the same WSL shell (interop runs it as a
real Windows process) or any Windows terminal:

```bash
target/windows/ddp-daemon.exe --engine-dir "$(realpath target/windows/engine)"
```

Open `http://localhost:9876`. Ctrl-C flushes pending `config.toml`
writes before exit; closing the console rides the same shutdown path
inside Windows' ~5 s grace window.
