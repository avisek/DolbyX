//! `SyntheticPlugin` — a real-protocol plugin client over the real
//! platform transport (`AF_UNIX` / named pipe), issue #19's mock
//! policy: the daemon's audio surface is tested from outside the
//! process boundary, nothing mocked past the `Engine` trait.

use std::path::Path;
use std::time::Duration;

use ddp_daemon::audio_server::{PluginMessage, read_plugin_message, write_plugin_message};

#[cfg(unix)]
type Stream = tokio::net::UnixStream;
#[cfg(windows)]
type Stream = tokio::net::windows::named_pipe::NamedPipeClient;

/// One synthetic plugin connection.
pub struct SyntheticPlugin {
    stream: Stream,
}

impl SyntheticPlugin {
    /// Connects to the daemon's plugin socket.
    pub async fn connect(path: &Path) -> Self {
        Self {
            stream: connect_stream(path).await,
        }
    }

    /// `Hello` → expects a `HelloAck`, returning the session id.
    pub async fn hello(&mut self, sample_rate: u32, max_frames: u32) -> u32 {
        self.send(&PluginMessage::Hello {
            sample_rate,
            max_frames,
        })
        .await;
        match self.recv().await {
            Some(PluginMessage::HelloAck { session_id }) => session_id,
            other => panic!("expected a HelloAck, got {other:?}"),
        }
    }

    /// `Hello` → expects the daemon's rejection: a `Goodbye`, then the
    /// connection closed.
    pub async fn hello_rejected(mut self, sample_rate: u32, max_frames: u32) {
        self.send(&PluginMessage::Hello {
            sample_rate,
            max_frames,
        })
        .await;
        self.expect_goodbye_and_close().await;
    }

    /// `Process` → expects a `Processed`, returning its PCM.
    pub async fn process(&mut self, pcm: &[i16]) -> Vec<i16> {
        self.send(&PluginMessage::Process { pcm: pcm.to_vec() })
            .await;
        match self.recv().await {
            Some(PluginMessage::Processed { pcm }) => pcm,
            other => panic!("expected a Processed, got {other:?}"),
        }
    }

    /// The clean close: says `Goodbye` and hangs up.
    pub async fn goodbye(mut self) {
        self.send(&PluginMessage::Goodbye).await;
    }

    /// Expects the daemon to say `Goodbye` and close — how it answers
    /// a rejected `Hello` or a protocol violation.
    pub async fn expect_goodbye_and_close(mut self) {
        assert_eq!(
            self.recv().await,
            Some(PluginMessage::Goodbye),
            "the daemon rejects in-protocol"
        );
        assert_eq!(self.recv().await, None, "…then closes the connection");
    }

    /// Sends one message.
    pub async fn send(&mut self, message: &PluginMessage) {
        let (opcode, payload) = message.encode();
        write_plugin_message(&mut self.stream, opcode, &payload)
            .await
            .expect("plugin send");
    }

    /// Receives the next message; `None` once the daemon closed.
    /// Bounded at 5 s so a silent daemon fails the test instead of
    /// hanging.
    pub async fn recv(&mut self) -> Option<PluginMessage> {
        tokio::time::timeout(
            Duration::from_secs(5),
            read_plugin_message(&mut self.stream),
        )
        .await
        .expect("no plugin message within 5s")
        .expect("plugin recv")
        .map(|(opcode, payload)| {
            PluginMessage::decode(opcode, &payload).expect("daemon speaks the protocol")
        })
    }
}

#[cfg(unix)]
async fn connect_stream(path: &Path) -> Stream {
    tokio::net::UnixStream::connect(path)
        .await
        .expect("connect the plugin socket")
}

#[cfg(windows)]
async fn connect_stream(path: &Path) -> Stream {
    use tokio::net::windows::named_pipe::ClientOptions;

    /// `ERROR_PIPE_BUSY`: every instance is taken — transient between
    /// an accept and the next instance standing up.
    const PIPE_BUSY: i32 = 231;

    let address = path.to_str().expect("pipe address is UTF-8");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        match ClientOptions::new().open(address) {
            Ok(stream) => return stream,
            Err(error) if error.raw_os_error() == Some(PIPE_BUSY) => {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "plugin pipe stayed busy for 5s"
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Err(error) => panic!("connect the plugin pipe: {error}"),
        }
    }
}
