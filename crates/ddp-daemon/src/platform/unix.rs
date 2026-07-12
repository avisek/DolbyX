//! Unix plugin transport: an `AF_UNIX` listener on
//! [`DEFAULT_SOCKET_PATH`] (or the `--socket-path` override for
//! dev/tests; the systemd `RuntimeDirectory`/ACL story is Slice 22,
//! [#30](https://github.com/avisek/DolbyX/issues/30)).

use std::io;
use std::os::unix::fs::FileTypeExt;
use std::path::Path;

use tokio::net::{UnixListener, UnixStream};

/// Where LV2/plugin shims find the daemon (epic #8).
pub const DEFAULT_SOCKET_PATH: &str = "/run/dolbyx/dolbyx.sock";

/// One accepted plugin connection.
pub type PluginStream = UnixStream;

/// The bound `AF_UNIX` plugin listener.
#[derive(Debug)]
pub struct PluginListener {
    listener: UnixListener,
}

impl PluginListener {
    /// Binds `path`, reclaiming only a *stale* socket file (a crashed
    /// daemon's — nothing answers it). A socket another daemon is
    /// serving, or a non-socket file, refuses with `AddrInUse` — the
    /// named-pipe adapter's `first_pipe_instance` semantics.
    ///
    /// # Errors
    ///
    /// [`io::ErrorKind::AddrInUse`] when the path is already claimed;
    /// otherwise the underlying bind error, e.g. a missing or
    /// unwritable parent directory.
    pub fn bind(path: &Path) -> io::Result<Self> {
        match std::fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_socket() => {
                if std::os::unix::net::UnixStream::connect(path).is_ok() {
                    return Err(io::Error::new(
                        io::ErrorKind::AddrInUse,
                        "another daemon is serving this socket",
                    ));
                }
                std::fs::remove_file(path)?;
            }
            Ok(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::AddrInUse,
                    "the path holds something that isn't a socket",
                ));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
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

#[cfg(test)]
mod tests {
    use std::os::unix::fs::FileTypeExt;

    use super::*;

    /// The three bind cases: a stale socket is reclaimed, a served
    /// socket refuses, a non-socket file refuses — never deleted.
    #[tokio::test]
    async fn bind_reclaims_stale_sockets_but_never_claimed_paths() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("dolbyx.sock");

        // A crashed daemon's leftover: the file exists, nobody answers.
        drop(PluginListener::bind(&path).expect("fresh bind"));
        assert!(
            std::fs::symlink_metadata(&path)
                .expect("socket file survives the drop")
                .file_type()
                .is_socket()
        );
        let live = PluginListener::bind(&path).expect("stale socket reclaimed");

        // A second daemon must not steal the live socket.
        let error = PluginListener::bind(&path).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AddrInUse, "{error}");
        drop(live);

        // A non-socket occupant refuses and survives.
        std::fs::remove_file(&path).expect("clear the socket");
        std::fs::write(&path, "not a socket").expect("plant a file");
        let error = PluginListener::bind(&path).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AddrInUse, "{error}");
        assert_eq!(
            std::fs::read_to_string(&path).expect("the file was not deleted"),
            "not a socket"
        );
    }
}
