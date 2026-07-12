//! Windows plugin transport: a named-pipe server on
//! [`DEFAULT_SOCKET_PATH`] (or the `--socket-path` override for
//! dev/tests), accepting one pipe instance per plugin connection.

use std::io;
use std::path::Path;

use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

/// Where the VST shim finds the daemon (epic #8).
pub const DEFAULT_SOCKET_PATH: &str = r"\\.\pipe\DolbyX";

/// One accepted plugin connection.
pub type PluginStream = NamedPipeServer;

/// The named-pipe plugin listener: always holds one idle server
/// instance so a client's connect never races the next `accept`.
#[derive(Debug)]
pub struct PluginListener {
    address: String,
    next: NamedPipeServer,
}

impl PluginListener {
    /// Creates the pipe's first instance, claiming the name — a second
    /// daemon on the same pipe fails here, mirroring `AddrInUse`.
    ///
    /// # Errors
    ///
    /// The underlying pipe-creation error, e.g. the name already taken.
    pub fn bind(path: &Path) -> io::Result<Self> {
        let address = path
            .to_str()
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "pipe address is not valid UTF-8",
                )
            })?
            .to_string();
        let next = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&address)?;
        Ok(Self { address, next })
    }

    /// Waits for the next plugin connection, standing up a fresh pipe
    /// instance behind it.
    ///
    /// # Errors
    ///
    /// The underlying connect or pipe-creation error.
    pub async fn accept(&mut self) -> io::Result<PluginStream> {
        self.next.connect().await?;
        let connected =
            std::mem::replace(&mut self.next, ServerOptions::new().create(&self.address)?);
        Ok(connected)
    }
}
