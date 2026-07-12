//! Windows plugin transport: a named-pipe server on
//! [`DEFAULT_SOCKET_PATH`] (or the `--socket-path` override for
//! dev/tests), accepting one pipe instance per plugin connection.

use std::io;
use std::path::Path;

use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use windows_sys::Win32::Security::{
    InitializeSecurityDescriptor, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, SECURITY_DESCRIPTOR,
    SetSecurityDescriptorDacl,
};
use windows_sys::Win32::System::SystemServices::SECURITY_DESCRIPTOR_REVISION;

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
        let next = create_instance(&address, true)?;
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
        let connected = std::mem::replace(&mut self.next, create_instance(&self.address, false)?);
        Ok(connected)
    }
}

/// Creates one pipe instance every local process may open. The VST
/// shim lives inside `audiodg.exe` (LOCAL SERVICE) — a different
/// principal from the daemon's user, which the default DACL denies
/// (`ERROR_ACCESS_DENIED`; v1's v0.5.1 lesson, fixed the same way):
/// a NULL DACL grants all local access. The pipe carries session audio
/// only — control is the Web UI, equally localhost-open by design.
fn create_instance(address: &str, first: bool) -> io::Result<NamedPipeServer> {
    let mut descriptor = SECURITY_DESCRIPTOR {
        Revision: 0,
        Sbz1: 0,
        Control: 0,
        Owner: std::ptr::null_mut(),
        Group: std::ptr::null_mut(),
        Sacl: std::ptr::null_mut(),
        Dacl: std::ptr::null_mut(),
    };
    let descriptor_ptr: PSECURITY_DESCRIPTOR = (&raw mut descriptor).cast();
    // SAFETY: `descriptor`/`attributes` are live, writable locals; the
    // kernel copies the descriptor into the pipe object during create,
    // so stack lifetime suffices. DaclPresent with a null ACL is the
    // documented NULL-DACL (allow-all) shape.
    unsafe {
        if InitializeSecurityDescriptor(descriptor_ptr, SECURITY_DESCRIPTOR_REVISION) == 0
            || SetSecurityDescriptorDacl(descriptor_ptr, 1, std::ptr::null(), 0) == 0
        {
            return Err(io::Error::last_os_error());
        }
        let mut attributes = SECURITY_ATTRIBUTES {
            nLength: u32::try_from(size_of::<SECURITY_ATTRIBUTES>()).expect("small struct"),
            lpSecurityDescriptor: descriptor_ptr,
            bInheritHandle: 0,
        };
        ServerOptions::new()
            .first_pipe_instance(first)
            .create_with_security_attributes_raw(address, (&raw mut attributes).cast())
    }
}
