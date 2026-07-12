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
    /// Engine backend. The default is the real engine (issue #16);
    /// `stub` fabricates replies — inner-loop dev/tests only.
    #[arg(long, value_enum, default_value_t = EngineKind::Qemu)]
    engine: EngineKind,
}

/// Which `Engine` implementation the daemon binds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
enum EngineKind {
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
    // The engine shim + libdseffect.so resolve beside the daemon
    // binary, like the runtime TOMLs. Refuse-to-start policy: a broken
    // staging fails here, loudly, before anything is served.
    let engine: std::sync::Arc<dyn ddp_engine::Engine> = match args.engine {
        EngineKind::Qemu => std::sync::Arc::new(
            ddp_engine::QemuBackend::start(&daemon_dir).map_err(|error| {
                format!("engine: {error} — is the engine staged beside the daemon binary? (`just stage-engine`)")
            })?,
        ),
        EngineKind::Stub => {
            tracing::warn!("running on the stub backend — no real audio processing");
            std::sync::Arc::new(ddp_engine::StubBackend::new())
        }
    };
    let config = DaemonConfig {
        port: args.port,
        ui_path: args.ui.unwrap_or_else(|| daemon_dir.join("index.html")),
        daemon_dir,
        config_dir: args.config_dir.unwrap_or_else(platform_config_dir),
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
    /// Slice 08 (issue #16): the default engine is the real one.
    #[test]
    fn the_default_port_is_9876_and_the_default_engine_is_qemu() {
        let args = Args::try_parse_from(["ddp-daemon"]).unwrap();
        assert_eq!(args.port, 9876);
        assert_eq!(args.ui, None);
        assert_eq!(args.config_dir, None);
        assert_eq!(args.engine, super::EngineKind::Qemu);

        let stubbed = Args::try_parse_from(["ddp-daemon", "--engine", "stub"]).unwrap();
        assert_eq!(stubbed.engine, super::EngineKind::Stub);
    }
}
