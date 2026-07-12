//! Platform transport to the daemon's plugin socket: the named pipe on
//! Windows, `AF_UNIX` where the synthetic-host tests run — mirroring
//! the daemon's two accept adapters (epic #8).

use std::io;

/// One connected duplex byte stream to the daemon. A named-pipe client
/// is just a file opened read+write.
#[cfg(windows)]
pub type Stream = std::fs::File;
/// One connected duplex byte stream to the daemon.
#[cfg(unix)]
pub type Stream = std::os::unix::net::UnixStream;

/// The daemon's default plugin address (epic #8).
#[cfg(windows)]
const DEFAULT_ADDRESS: &str = r"\\.\pipe\DolbyX";
/// The daemon's default plugin address (epic #8).
#[cfg(unix)]
const DEFAULT_ADDRESS: &str = "/run/dolbyx/dolbyx.sock";

/// Overrides the address — the plugin-side mirror of the daemon's
/// `--socket-path` flag, for dev daemons on non-default sockets and
/// the synthetic-host tests.
const ADDRESS_ENV: &str = "DOLBYX_SOCKET_PATH";

/// Connects to the daemon, fast-fail: no daemon (or every pipe
/// instance busy) errors immediately — the audio thread throttles its
/// retries instead of ever waiting here.
///
/// SIGPIPE note for the LV2 extraction (issue #21): inside a non-Rust
/// host a write to a hung-up `AF_UNIX` socket raises SIGPIPE, which no
/// Rust `main` has masked — the shared crate must mask it (the Windows
/// pipe, and Rust test harnesses, are immune).
pub fn connect() -> io::Result<Stream> {
    let address = std::env::var(ADDRESS_ENV).unwrap_or_else(|_| DEFAULT_ADDRESS.to_string());
    #[cfg(windows)]
    {
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(address)
    }
    #[cfg(unix)]
    {
        Stream::connect(address)
    }
}
