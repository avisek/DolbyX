//! The engine shim: ARMv7 binary that dlopens `libdseffect.so` (from
//! its own directory), routes sessions, and serves the daemon↔engine
//! protocol over stdin/stdout — the only code touching the engine's
//! exported symbols (`ffi` carries the `unsafe`, per ADR-0001).
//! Protocol frames are the single definition in `ddp_engine::protocol`;
//! stdout carries nothing else (the engine's own log, via the staged
//! `liblog` stub, goes to stderr).
//!
//! Lifecycle ops ride the engine's cmd protocol; `SetParams` /
//! `GetParams` go AK-direct (ADR-0010).

#![deny(unsafe_code)]

#[expect(unsafe_code, reason = "the engine FFI boundary (ADR-0001)")]
mod ffi;
mod session;

use std::io::{self, Read, Write};
use std::process::ExitCode;

use ddp_engine::protocol::{
    Command, STATUS_INVALID, STATUS_OK, encode_get_params_reply, read_message, write_reply,
};

use crate::ffi::{ENODATA, EngineLib};
use crate::session::SessionTable;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("ddp-engine-arm: {message}");
            ExitCode::FAILURE
        }
    }
}

/// Loads the engine and serves frames until stdin closes (the daemon
/// hanging up is the shutdown signal — no shutdown opcode exists).
fn run() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|error| format!("current_exe: {error}"))?;
    let lib_path = exe
        .parent()
        .ok_or("executable has no parent directory")?
        .join("libdseffect.so");
    let lib = EngineLib::load(&lib_path)?;
    let mut sessions = SessionTable::new(&lib);
    serve(&mut sessions, io::stdin().lock(), io::stdout().lock())
        .map_err(|error| format!("protocol stream: {error}"))
}

/// One reply per message, in order, flushed eagerly — the daemon blocks
/// on each reply.
fn serve(
    sessions: &mut SessionTable<'_>,
    mut input: impl Read,
    mut output: impl Write,
) -> io::Result<()> {
    let mut scratch = Vec::new();
    while let Some((opcode, payload)) = read_message(&mut input)? {
        let (status, reply) = dispatch(sessions, opcode, &payload, &mut scratch);
        write_reply(&mut output, status, &reply)?;
        output.flush()?;
    }
    Ok(())
}

/// Decodes and executes one message. Malformed frames get an error
/// status and the shim stays alive; only a broken stream is fatal.
fn dispatch(
    sessions: &mut SessionTable<'_>,
    opcode: u32,
    payload: &[u8],
    scratch: &mut Vec<i16>,
) -> (i32, Vec<u8>) {
    let command = match Command::decode(opcode, payload) {
        Ok(command) => command,
        Err(error) => {
            eprintln!("ddp-engine-arm: rejecting frame: {error}");
            return (STATUS_INVALID, Vec::new());
        }
    };
    match command {
        Command::CreateSession { sample_rate } => match sessions.create(sample_rate) {
            Ok(id) => (STATUS_OK, id.to_le_bytes().to_vec()),
            Err(status) => (status, Vec::new()),
        },
        Command::DestroySession { session_id } => status_only(sessions.destroy(session_id)),
        Command::SetEnabled {
            session_id,
            enabled,
        } => status_only(
            sessions
                .get_mut(session_id)
                .and_then(|session| session.set_enabled(enabled)),
        ),
        Command::SetParams { session_id, params } => status_only(
            sessions
                .get_mut(session_id)
                .map(|session| session.set_params(&params)),
        ),
        Command::GetParams { session_id, names } => match sessions.get_mut(session_id) {
            Ok(session) => (
                STATUS_OK,
                encode_get_params_reply(&session.get_params(&names)),
            ),
            Err(status) => (status, Vec::new()),
        },
        Command::Process {
            session_id,
            mut pcm,
        } => {
            let session = match sessions.get_mut(session_id) {
                Ok(session) => session,
                Err(status) => return (status, Vec::new()),
            };
            // WRITE mode: the engine overwrites the whole output — no
            // per-block zeroing; `resize` only touches first-use growth.
            scratch.resize(pcm.len(), 0);
            let output = &mut scratch[..pcm.len()];
            let status = session.process(&mut pcm, output);
            // Enabled, crossfading, and bypassed blocks are all "ship
            // the output": bypass (-ENODATA) already deposited the dry
            // input (setconfig_probe Sc9).
            if status == 0 || status == -ENODATA {
                let tail = session.vis_tail();
                let mut reply = Vec::with_capacity((output.len() + tail.len()) * 2);
                reply.extend(output.iter().flat_map(|sample| sample.to_le_bytes()));
                reply.extend(tail.iter().flat_map(|sample| sample.to_le_bytes()));
                (STATUS_OK, reply)
            } else {
                (status, Vec::new())
            }
        }
    }
}

/// Collapses an empty-reply outcome into `(status, empty)`.
fn status_only(result: Result<(), i32>) -> (i32, Vec<u8>) {
    (
        result.map_or_else(|status| status, |()| STATUS_OK),
        Vec::new(),
    )
}
