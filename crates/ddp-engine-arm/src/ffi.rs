//! The `libdseffect.so` binding — DolbyX's only `unsafe` (ADR-0001):
//! dlopen plus the Android `AudioEffect` vtable, wrapped into safe
//! lifecycle calls. Layouts mirror `tools/ddp_probe/audio_effect_defs.h`
//! and are only correct at runtime on 32-bit ARM (pointers = 4 bytes),
//! the sole target this binary ships for; host builds merely lint.
//!
//! Lifecycle stays on the cmd protocol (ADR-0010): `EFFECT_CMD_INIT`,
//! one `EFFECT_CMD_SET_CONFIG` pinning stereo + PCM16 + WRITE output
//! mode, `ENABLE`/`DISABLE`, `process()`. The AK-direct param surface
//! lands in Slice 07 ([#15](https://github.com/avisek/DolbyX/issues/15)).

use std::ffi::c_void;
use std::marker::PhantomData;
use std::path::Path;

/// `EFFECT_CMD_INIT` — effect command 0.
const EFFECT_CMD_INIT: u32 = 0;
/// `EFFECT_CMD_SET_CONFIG` — effect command 1.
const EFFECT_CMD_SET_CONFIG: u32 = 1;
/// `EFFECT_CMD_ENABLE` — effect command 3.
const EFFECT_CMD_ENABLE: u32 = 3;
/// `EFFECT_CMD_DISABLE` — effect command 4.
const EFFECT_CMD_DISABLE: u32 = 4;

/// `-ENODATA`: what `process()` returns on a fully bypassed block —
/// which still deposits the dry input into the output in WRITE mode
/// (`setconfig_probe` Sc9), so callers treat it as success.
pub const ENODATA: i32 = 61;

/// The frame count baked into `EFFECT_CMD_SET_CONFIG`. The engine
/// re-inits its internal buffer at a fixed 256 regardless (the
/// `Ds1apBufferInit` call inside `Effect_reinit`); `process()` takes
/// its real per-call count from `audio_buffer_t.frame_count`.
const CONFIG_FRAME_COUNT: u32 = 256;

/// AOSP `audio_buffer_t` (ARM32: `size_t` = `u32`).
#[repr(C)]
struct AudioBuffer {
    frame_count: u32,
    raw: *mut c_void,
}

/// AOSP `effect_interface_s` — the vtable behind an effect handle.
#[repr(C)]
struct EffectInterface {
    process: unsafe extern "C" fn(RawHandle, *mut AudioBuffer, *mut AudioBuffer) -> i32,
    command: unsafe extern "C" fn(RawHandle, u32, u32, *mut c_void, *mut u32, *mut c_void) -> i32,
    get_descriptor: *const c_void,
    reserved: [*const c_void; 5],
}

/// AOSP `effect_handle_t`: pointer to a pointer to the vtable.
type RawHandle = *mut *const EffectInterface;

/// AOSP `effect_descriptor_t` — only `uuid` is consumed (fed back to
/// `EffectCreate`, which insists on the exact pair it published).
#[repr(C)]
struct EffectDescriptor {
    type_uuid: [u8; 16],
    uuid: [u8; 16],
    api_version: u32,
    flags: u32,
    cpu_load: u16,
    memory_usage: u16,
    name: [u8; 64],
    implementor: [u8; 64],
}

impl EffectDescriptor {
    const fn zeroed() -> Self {
        Self {
            type_uuid: [0; 16],
            uuid: [0; 16],
            api_version: 0,
            flags: 0,
            cpu_load: 0,
            memory_usage: 0,
            name: [0; 64],
            implementor: [0; 64],
        }
    }
}

type EffectQueryEffectFn = unsafe extern "C" fn(u32, *mut EffectDescriptor) -> i32;
type EffectCreateFn = unsafe extern "C" fn(*const [u8; 16], i32, i32, *mut RawHandle) -> i32;
type EffectReleaseFn = unsafe extern "C" fn(RawHandle) -> i32;

/// The loaded engine library: its entry points, resolved once at
/// startup, plus the effect UUID it publishes. The `Library` mapping
/// keeps every resolved pointer valid; `Effect`'s lifetime ties handles
/// to it.
pub struct EngineLib {
    _library: libloading::Library,
    create: EffectCreateFn,
    release: EffectReleaseFn,
    uuid: [u8; 16],
}

impl EngineLib {
    /// Loads `libdseffect.so`, resolves every entry point, and reads
    /// the engine's effect descriptor.
    ///
    /// # Errors
    ///
    /// A human-readable message when the library or a symbol fails to
    /// load, or the descriptor query fails — all fatal at startup.
    pub fn load(path: &Path) -> Result<Self, String> {
        // SAFETY: loading runs the library's initialisers. The path is
        // resolved to the vendored `libdseffect.so` staged beside this
        // binary — the exact artifact the probe harness exercises.
        let library = unsafe { libloading::Library::new(path) }
            .map_err(|error| format!("dlopen {}: {error}", path.display()))?;

        /// Resolves one exported fn pointer out of its `Symbol` guard;
        /// the caller's `Library` keeps it valid.
        macro_rules! entry_point {
            ($name:literal as $ty:ty) => {{
                // SAFETY: the symbol is used at its published signature
                // (`tools/ddp_probe/audio_effect_defs.h`).
                let symbol = unsafe { library.get::<$ty>(concat!($name, "\0").as_bytes()) }
                    .map_err(|error| format!("dlsym {}: {error}", $name))?;
                *symbol
            }};
        }

        let query = entry_point!("EffectQueryEffect" as EffectQueryEffectFn);
        let create = entry_point!("EffectCreate" as EffectCreateFn);
        let release = entry_point!("EffectRelease" as EffectReleaseFn);

        let mut descriptor = EffectDescriptor::zeroed();
        // SAFETY: `EffectQueryEffect` fills the descriptor struct we
        // own; index 0 is the engine's only effect.
        let status = unsafe { query(0, &raw mut descriptor) };
        if status != 0 {
            return Err(format!("EffectQueryEffect(0) failed: {status}"));
        }
        Ok(Self {
            _library: library,
            create,
            release,
            uuid: descriptor.uuid,
        })
    }

    /// Creates one engine effect handle (`EffectCreate`), keyed by an
    /// Android audio-session number.
    ///
    /// # Errors
    ///
    /// The engine's negative status when creation fails.
    pub fn create_effect(&self, android_session: i32) -> Result<Effect<'_>, i32> {
        let mut handle: RawHandle = std::ptr::null_mut();
        // SAFETY: `EffectCreate` writes the new handle through our
        // out-pointer; the UUID buffer outlives the call.
        let status = unsafe {
            (self.create)(
                &raw const self.uuid,
                android_session,
                android_session,
                &raw mut handle,
            )
        };
        if status != 0 || handle.is_null() {
            return Err(if status == 0 {
                ddp_engine::protocol::STATUS_INVALID
            } else {
                status
            });
        }
        Ok(Effect {
            handle,
            release: self.release,
            _lib: PhantomData,
        })
    }
}

/// One live effect handle; releases itself on drop.
pub struct Effect<'lib> {
    handle: RawHandle,
    release: EffectReleaseFn,
    _lib: PhantomData<&'lib EngineLib>,
}

impl Effect<'_> {
    /// Runs one effect command, checking both failure surfaces: the
    /// `command()` return *and* the reply word (a `SET_CONFIG` field
    /// reject returns 0 but writes reply −22 — `docs/ddp/03`).
    ///
    /// # Errors
    ///
    /// The engine's negative status.
    fn command(&mut self, code: u32, data: &mut [u8]) -> Result<(), i32> {
        let mut reply: i32 = 0;
        let mut reply_size: u32 = 4;
        let size = u32::try_from(data.len()).expect("command payloads are tiny");
        let pointer = if data.is_empty() {
            std::ptr::null_mut()
        } else {
            data.as_mut_ptr().cast::<c_void>()
        };
        // SAFETY: `handle` is live (owned by us, released only in Drop);
        // `data` outlives the call; reply out-params point at locals.
        let status = unsafe {
            ((**self.handle).command)(
                self.handle,
                code,
                size,
                pointer,
                &raw mut reply_size,
                (&raw mut reply).cast::<c_void>(),
            )
        };
        match status {
            0 if reply == 0 => Ok(()),
            0 => Err(reply),
            _ => Err(status),
        }
    }

    /// `EFFECT_CMD_INIT`.
    ///
    /// # Errors
    ///
    /// The engine's negative status.
    pub fn init(&mut self) -> Result<(), i32> {
        self.command(EFFECT_CMD_INIT, &mut [])
    }

    /// One `EFFECT_CMD_SET_CONFIG` at `sample_rate`, pinning stereo +
    /// PCM16 + WRITE output mode. The engine validates, rebuilds its
    /// `Ds1ap` at the rate, and re-applies cached AK params.
    ///
    /// # Errors
    ///
    /// The engine's negative status (either failure surface).
    pub fn set_config(&mut self, sample_rate: u32) -> Result<(), i32> {
        let mut config = effect_config(sample_rate);
        self.command(EFFECT_CMD_SET_CONFIG, &mut config)
    }

    /// `EFFECT_CMD_ENABLE` / `EFFECT_CMD_DISABLE` (idempotent in the
    /// engine). Disable is engine-owned: a ≈125 ms wet→dry crossfade,
    /// then bypass.
    ///
    /// # Errors
    ///
    /// The engine's negative status.
    pub fn set_enabled(&mut self, enabled: bool) -> Result<(), i32> {
        let code = if enabled {
            EFFECT_CMD_ENABLE
        } else {
            EFFECT_CMD_DISABLE
        };
        self.command(code, &mut [])
    }

    /// Processes one interleaved-stereo block, engine-overwriting
    /// `output` (WRITE mode). Returns the raw `process()` status:
    /// `0` while active or crossfading, `-ENODATA` once bypassed (the
    /// dry input is already deposited — same contract either way).
    /// The engine also clobbers `input`; callers copy first if they
    /// still need it.
    ///
    /// # Panics
    ///
    /// When the buffers aren't equal-length interleaved stereo.
    pub fn process(&mut self, input: &mut [i16], output: &mut [i16]) -> i32 {
        assert_eq!(input.len(), output.len(), "WRITE mode mirrors buffers");
        assert_eq!(input.len() % 2, 0, "interleaved stereo");
        let frame_count = u32::try_from(input.len() / 2).expect("frame counts are u32");
        let mut in_buffer = AudioBuffer {
            frame_count,
            raw: input.as_mut_ptr().cast::<c_void>(),
        };
        let mut out_buffer = AudioBuffer {
            frame_count,
            raw: output.as_mut_ptr().cast::<c_void>(),
        };
        // SAFETY: `handle` is live; both buffers are exclusive borrows
        // sized `frame_count × 2` i16 samples, exactly what the engine
        // reads and overwrites.
        unsafe { ((**self.handle).process)(self.handle, &raw mut in_buffer, &raw mut out_buffer) }
    }
}

impl Drop for Effect<'_> {
    fn drop(&mut self) {
        // SAFETY: `handle` is live and owned; after this it is never
        // touched again.
        unsafe {
            (self.release)(self.handle);
        }
    }
}

/// The 64-byte AOSP `effect_config_t` (input ‖ output
/// `buffer_config_t`), built by offset so host-width pointers can't
/// skew the ARM32 layout — `setconfig_probe.c`'s `cfg_t` is the
/// authoritative map. Pins stereo (mask 3), PCM16, WRITE output mode.
fn effect_config(sample_rate: u32) -> [u8; 64] {
    let mut config = [0_u8; 64];
    for base in [0, 32] {
        config[base..base + 4].copy_from_slice(&CONFIG_FRAME_COUNT.to_le_bytes());
        // @4 raw buffer pointer, @16..28 buffer_provider: all NULL.
        config[base + 8..base + 12].copy_from_slice(&sample_rate.to_le_bytes());
        config[base + 12..base + 16].copy_from_slice(&3_u32.to_le_bytes()); // stereo mask
        config[base + 28] = 1; // AUDIO_FORMAT_PCM_16_BIT
        config[base + 29] = 0; // EFFECT_BUFFER_ACCESS_WRITE
    }
    config
}
