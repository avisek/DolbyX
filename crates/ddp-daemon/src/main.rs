//! DolbyX daemon binary: CLI parsing, path resolution, and the run loop
//! around [`ddp_daemon::Daemon`].

#![forbid(unsafe_code)]

use std::path::PathBuf;
use std::process::ExitCode;

use clap::Parser;
use ddp_daemon::{Daemon, DaemonConfig};

/// DolbyX daemon: HTTP/WS server + audio-plugin IPC + engine
/// supervision in one binary.
#[derive(Debug, Parser)]
#[command(version)]
struct Args {
    /// TCP port for `GET /` + `GET /ws`.
    #[arg(long, default_value_t = 9876)]
    port: u16,
    /// UI HTML file override (dev runs `--ui ui/dev.html`); defaults to
    /// `index.html` beside the binary.
    #[arg(long)]
    ui: Option<PathBuf>,
    /// `config.toml` directory override for tests/dev; defaults to the
    /// platform data dir.
    #[arg(long)]
    config_dir: Option<PathBuf>,
    /// Plugin socket override for tests/dev (Unix socket path / Windows
    /// pipe name); defaults to the platform address
    /// (`/run/dolbyx/dolbyx.sock`, `\\.\pipe\DolbyX`).
    #[arg(long, default_value = ddp_daemon::platform::DEFAULT_SOCKET_PATH)]
    socket_path: PathBuf,
    /// Backend binding the `Engine` trait. The default is the real
    /// engine (issue #16); `stub` fabricates replies — inner-loop
    /// dev/tests only.
    #[arg(long, value_enum, default_value_t = BackendKind::Qemu)]
    backend: BackendKind,
    /// Engine directory for the QEMU backend — on Windows a WSL-side
    /// Linux path (issue #20). Defaults beside the daemon binary
    /// (Unix) / `/opt/dolbyx/engine` (Windows).
    #[arg(long)]
    engine_dir: Option<PathBuf>,
}

/// The directory the QEMU backend loads the shim from: `--engine-dir`,
/// else beside the daemon binary — except on Windows, where the engine
/// lives inside WSL2 at the Linux path `setup-windows.bat` installs
/// (`docs/windows.md`). A Windows-looking path is refused up front: it
/// would spawn a broken shim inside WSL and fail obscurely at probe.
fn resolve_engine_dir(
    flag: Option<PathBuf>,
    daemon_dir: &std::path::Path,
) -> Result<PathBuf, String> {
    let dir = flag.unwrap_or_else(|| {
        if cfg!(windows) {
            PathBuf::from("/opt/dolbyx/engine")
        } else {
            daemon_dir.to_path_buf()
        }
    });
    let text = dir.to_string_lossy();
    if cfg!(windows) && (text.contains(':') || text.starts_with(r"\\")) {
        return Err(format!(
            "--engine-dir {text} looks like a Windows path; on Windows it names a \
             WSL-side Linux path (e.g. /opt/dolbyx/engine, or `wslpath -u <dir>`)"
        ));
    }
    Ok(dir)
}

/// Which backend the daemon binds behind the `Engine` trait.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
enum BackendKind {
    /// `QemuBackend`: `libdseffect.so` under `qemu-arm-static`, staged
    /// beside the daemon binary (`just stage-engine` in dev).
    Qemu,
    /// `StubBackend`: no subprocess, no real audio processing.
    Stub,
}

/// The platform data dir carrying `config.toml`
/// (`/var/lib/dolbyx`, `%PROGRAMDATA%\DolbyX`).
fn platform_config_dir() -> PathBuf {
    if cfg!(windows) {
        let base = std::env::var_os("PROGRAMDATA").unwrap_or_else(|| r"C:\ProgramData".into());
        PathBuf::from(base).join("DolbyX")
    } else {
        PathBuf::from("/var/lib/dolbyx")
    }
}

fn main() -> ExitCode {
    init_tracing();
    let args = Args::parse();
    match run(args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            // Refuse-to-start policy: fail loudly with the cause.
            eprintln!("ddp-daemon: {error}");
            ExitCode::FAILURE
        }
    }
}

/// Epic #8 logging: stdout human-readable under the `RUST_LOG` filter
/// (default `info`), errors duplicated to stderr. (The rotating file
/// target waits for Slice 22, #30.)
fn init_tracing() {
    use std::io::IsTerminal;

    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    use tracing_subscriber::{EnvFilter, Layer, filter::LevelFilter, fmt};

    tracing_subscriber::registry()
        .with(
            fmt::layer()
                .with_ansi(std::io::stdout().is_terminal())
                .with_filter(
                    EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
                ),
        )
        .with(
            fmt::layer()
                .with_writer(std::io::stderr)
                .with_ansi(std::io::stderr().is_terminal())
                .with_filter(LevelFilter::ERROR),
        )
        .init();
}

/// Resolves on Ctrl-C, SIGTERM (Unix service managers), or console
/// close (Windows) — every path then flushes via `Daemon::shutdown`.
async fn shutdown_signal() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    let close = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install the SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(windows)]
    let close = async {
        tokio::signal::windows::ctrl_close()
            .expect("install the console close handler")
            .recv()
            .await;
    };
    tokio::select! {
        result = ctrl_c => result.expect("install the Ctrl-C handler"),
        () = close => {}
    }
}

/// Resolves paths, starts the engine + daemon, and serves until
/// interrupted.
fn run(args: Args) -> Result<(), Box<dyn std::error::Error>> {
    let daemon_dir = std::env::current_exe()?
        .parent()
        .ok_or("cannot resolve the daemon binary's directory")?
        .to_path_buf();
    // Refuse-to-start policy: a broken staging fails here, loudly,
    // before anything is served.
    let engine_dir = resolve_engine_dir(args.engine_dir, &daemon_dir)?;
    let staging_hint = if cfg!(windows) {
        r"run scripts\setup-windows.bat, or point --engine-dir at a staged WSL directory"
    } else {
        "is the engine staged beside the daemon binary? (`just stage-engine`)"
    };
    let engine: std::sync::Arc<dyn ddp_engine::Engine> = match args.backend {
        BackendKind::Qemu => std::sync::Arc::new(
            ddp_engine::QemuBackend::start(&engine_dir)
                .map_err(|error| format!("engine: {error} — {staging_hint}"))?,
        ),
        BackendKind::Stub => {
            tracing::warn!("running on the stub backend — no real audio processing");
            std::sync::Arc::new(ddp_engine::StubBackend::new())
        }
    };
    let config = DaemonConfig {
        port: args.port,
        // The LAN door is all interfaces — fixed, no `--bind` flag
        // (ADR-0012); whether it is open is the `lan_access` toggle.
        lan_ip: std::net::Ipv4Addr::UNSPECIFIED.into(),
        ui_path: args.ui.unwrap_or_else(|| daemon_dir.join("index.html")),
        daemon_dir,
        config_dir: args.config_dir.unwrap_or_else(platform_config_dir),
        socket_path: args.socket_path,
    };

    tokio::runtime::Runtime::new()?.block_on(async {
        let daemon = Daemon::start(config, engine).await?;
        tracing::info!(addr = %daemon.addr(), "listening");
        shutdown_signal().await;
        tracing::info!("shutting down");
        daemon.shutdown().await;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use clap::Parser;

    use super::Args;

    /// Behavior 1 (issue #12): the daemon binds :9876 by default.
    /// Slice 08 (issue #16): the default backend is the real engine.
    /// Slice 11 (issue #19): the plugin socket defaults to the platform
    /// address.
    #[test]
    fn the_default_port_is_9876_and_the_default_backend_is_qemu() {
        let args = Args::try_parse_from(["ddp-daemon"]).unwrap();
        assert_eq!(args.port, 9876);
        assert_eq!(args.ui, None);
        assert_eq!(args.config_dir, None);
        assert_eq!(args.backend, super::BackendKind::Qemu);
        assert_eq!(
            args.socket_path,
            std::path::PathBuf::from(ddp_daemon::platform::DEFAULT_SOCKET_PATH)
        );

        let stubbed = Args::try_parse_from(["ddp-daemon", "--backend", "stub"]).unwrap();
        assert_eq!(stubbed.backend, super::BackendKind::Stub);
    }

    /// Slice 12 (issue #20): without `--engine-dir` the engine resolves
    /// beside the daemon binary on Unix, and on Windows at the WSL-side
    /// directory `setup-windows.bat` installs.
    #[test]
    fn the_engine_dir_defaults_per_platform() {
        let daemon_dir = std::path::Path::new("/opt/daemon");
        let expected = if cfg!(windows) {
            "/opt/dolbyx/engine"
        } else {
            "/opt/daemon"
        };
        assert_eq!(
            super::resolve_engine_dir(None, daemon_dir).unwrap(),
            std::path::Path::new(expected)
        );
        assert_eq!(
            super::resolve_engine_dir(Some("/staged".into()), daemon_dir).unwrap(),
            std::path::Path::new("/staged")
        );
    }

    /// Slice 12 (issue #20): a Windows-style `--engine-dir` refuses to
    /// start — the flag names a WSL-side Linux path on Windows.
    #[cfg(windows)]
    #[test]
    fn windows_style_engine_dirs_are_refused() {
        let daemon_dir = std::path::Path::new("/opt/daemon");
        for wrong in [r"C:\DolbyX\engine", r"\\wsl.localhost\Ubuntu\opt"] {
            let error = super::resolve_engine_dir(Some(wrong.into()), daemon_dir).unwrap_err();
            assert!(error.contains("WSL-side Linux path"), "{error}");
        }
    }
}
