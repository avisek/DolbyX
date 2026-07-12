//! Unix plugin transport: an `AF_UNIX` listener on
//! [`DEFAULT_SOCKET_PATH`] (or the `--socket-path` override for
//! dev/tests; the systemd `RuntimeDirectory`/ACL story is Slice 22,
//! [#30](https://github.com/avisek/DolbyX/issues/30)).

use std::io;
use std::path::Path;

use tokio::net::{UnixListener, UnixStream};

/// Where LV2/plugin shims find the daemon (epic #8).
pub const DEFAULT_SOCKET_PATH: &str = "/run/dolbyx/dolbyx.sock";

/// One accepted plugin connection.
pub type PluginStream = UnixStream;

/// The bound `AF_UNIX` plugin listener.
pub struct PluginListener {
    listener: UnixListener,
}

impl PluginListener {
    /// Binds `path`, claiming it: a leftover socket file (a crashed
    /// daemon's) is removed first — two daemons on one path is a
    /// config error, not a case to arbitrate.
    ///
    /// # Errors
    ///
    /// The underlying bind error, e.g. a missing or unwritable parent
    /// directory.
    pub fn bind(path: &Path) -> io::Result<Self> {
        if path.exists() {
            std::fs::remove_file(path)?;
        }
        Ok(Self {
            listener: UnixListener::bind(path)?,
        })
    }

    /// Waits for and returns the next plugin connection.
    ///
    /// # Errors
    ///
    /// The underlying accept error.
    pub async fn accept(&mut self) -> io::Result<PluginStream> {
        let (stream, _) = self.listener.accept().await?;
        Ok(stream)
    }
}
