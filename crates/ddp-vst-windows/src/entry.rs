//! The exported VST2 surface: `VSTPluginMain` plus the host-called
//! dispatcher and process callbacks — the crate's FFI boundary (host
//! raw pointers in, safe [`Effect`] calls out).

use std::ffi::{CStr, c_void};
use std::sync::{Mutex, MutexGuard, PoisonError};

use crate::editor;
use crate::effect::Effect;
use crate::vst2::{
    AEffect, AUDIO_MASTER_VERSION, AudioMasterCallback, EFF_CAN_DO, EFF_CLOSE, EFF_EDIT_GET_RECT,
    EFF_EDIT_OPEN, EFF_FLAGS_CAN_REPLACING, EFF_FLAGS_HAS_EDITOR, EFF_GET_EFFECT_NAME,
    EFF_GET_PLUG_CATEGORY, EFF_GET_PRODUCT_STRING, EFF_GET_VENDOR_STRING, EFF_GET_VENDOR_VERSION,
    EFF_GET_VST_VERSION, EFF_MAINS_CHANGED, EFF_SET_SAMPLE_RATE, EFFECT_MAGIC, ERect,
    PLUG_CATEG_EFFECT, VST_VERSION,
};

/// v1's registered plugin id (`'DDP1'`) — unchanged, so host caches
/// (a DAW's plugin database) carry over.
const UNIQUE_ID: i32 = 0x4444_5031;
/// The plugin's own version — 2.0.0.
const VERSION: i32 = 200;
/// The identity every `effGet…String` reports.
const NAME: &str = "DolbyX";

/// The state behind `AEffect.object`. Dispatcher calls arrive on the
/// host's UI thread while `processReplacing` runs on its audio thread;
/// the lock is uncontended outside those brief overlaps and vanishes
/// against the per-block pipe round trip.
type Shared = Mutex<Effect>;

/// The VST2 entry — `VSTPluginMain` in the DLL's export table (the
/// name EqualizerAPO resolves).
///
/// Returns null when the host fails its version probe; otherwise the
/// `AEffect` the host drives, live until its `effClose`.
#[unsafe(export_name = "VSTPluginMain")]
pub extern "C" fn vst_plugin_main(audio_master: AudioMasterCallback) -> *mut AEffect {
    let Some(host) = audio_master else {
        return std::ptr::null_mut();
    };
    // SAFETY: probing the host callback per the VST2 contract (a null
    // effect is the defined shape for pre-construction calls).
    let host_version = unsafe {
        host(
            std::ptr::null_mut(),
            AUDIO_MASTER_VERSION,
            0,
            0,
            std::ptr::null_mut(),
            0.0,
        )
    };
    if host_version == 0 {
        return std::ptr::null_mut();
    }
    let object: *mut Shared = Box::into_raw(Box::new(Mutex::new(Effect::new())));
    Box::into_raw(Box::new(AEffect {
        magic: EFFECT_MAGIC,
        dispatcher: Some(dispatcher),
        process_deprecated: None,
        set_parameter: Some(set_parameter),
        get_parameter: Some(get_parameter),
        num_programs: 1,
        num_params: 0,
        num_inputs: 2,
        num_outputs: 2,
        flags: EFF_FLAGS_CAN_REPLACING | EFF_FLAGS_HAS_EDITOR,
        resvd1: 0,
        resvd2: 0,
        // Every block round-trips synchronously — no latency to report.
        initial_delay: 0,
        real_qualities: 0,
        off_qualities: 0,
        io_ratio: 0.0,
        object: object.cast(),
        user: std::ptr::null_mut(),
        unique_id: UNIQUE_ID,
        version: VERSION,
        process_replacing: Some(process_replacing),
        process_double_replacing: None,
        future: [0; 56],
    }))
}

/// The state behind `effect` — `None` on a null effect or one already
/// closed.
///
/// # Safety
///
/// `effect` must be null or a pointer [`vst_plugin_main`] returned
/// that hasn't seen `effClose`.
unsafe fn shared<'a>(effect: *mut AEffect) -> Option<&'a Shared> {
    // SAFETY: per this function's contract.
    unsafe {
        effect
            .as_ref()
            .and_then(|effect| effect.object.cast::<Shared>().as_ref())
    }
}

/// Locks the state; a poisoned lock (a panicked peer call) must not
/// wedge audio forever.
fn lock(shared: &Shared) -> MutexGuard<'_, Effect> {
    shared.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The host's opcode surface. Unhandled opcodes return 0 ("not
/// supported"), per convention.
unsafe extern "C" fn dispatcher(
    effect: *mut AEffect,
    opcode: i32,
    _index: i32,
    value: isize,
    ptr: *mut c_void,
    opt: f32,
) -> isize {
    // SAFETY: hosts pass back the pointer this entry minted.
    let Some(shared) = (unsafe { shared(effect) }) else {
        return 0;
    };
    match opcode {
        EFF_CLOSE => {
            lock(shared).close();
            // SAFETY: effClose is the host's final call on this
            // instance — reclaim both allocations the entry minted.
            // Neither `shared` nor `effect` is touched past here.
            unsafe {
                let object = (*effect).object.cast::<Shared>();
                (*effect).object = std::ptr::null_mut();
                drop(Box::from_raw(object));
                drop(Box::from_raw(effect));
            }
            0
        }
        EFF_SET_SAMPLE_RATE => {
            lock(shared).set_sample_rate(opt);
            0
        }
        EFF_MAINS_CHANGED => {
            if value == 0 {
                lock(shared).suspend();
            } else {
                lock(shared).resume();
            }
            0
        }
        EFF_EDIT_GET_RECT => {
            /// Zero-sized: the UI lives in the browser.
            static EDITOR_RECT: ERect = ERect {
                top: 0,
                left: 0,
                bottom: 0,
                right: 0,
            };
            if ptr.is_null() {
                return 0;
            }
            // SAFETY: the host hands an `ERect**` to fill.
            unsafe { *ptr.cast::<*const ERect>() = &raw const EDITOR_RECT };
            1
        }
        EFF_EDIT_OPEN => {
            editor::open(ptr);
            1
        }
        EFF_GET_EFFECT_NAME | EFF_GET_VENDOR_STRING | EFF_GET_PRODUCT_STRING => {
            // SAFETY: the host sized the buffer per the opcode (≥ 32).
            unsafe { write_identity(ptr) }
        }
        EFF_GET_VENDOR_VERSION => VERSION as isize,
        EFF_GET_VST_VERSION => VST_VERSION,
        EFF_GET_PLUG_CATEGORY => PLUG_CATEG_EFFECT,
        // SAFETY: the host passes a NUL-terminated capability name.
        EFF_CAN_DO => unsafe { can_do(ptr) },
        // Everything else — including effOpen (state was minted in the
        // entry; the daemon link opens on resume) — is "not supported".
        _ => 0,
    }
}

/// Writes `"DolbyX\0"` into the host's name buffer, returning 1.
///
/// # Safety
///
/// `ptr` must be null or writable for the opcode's VST2 minimum
/// (32 bytes — [`NAME`] plus NUL is 7).
unsafe fn write_identity(ptr: *mut c_void) -> isize {
    if ptr.is_null() {
        return 0;
    }
    // SAFETY: per this function's contract.
    unsafe {
        std::ptr::copy_nonoverlapping(NAME.as_ptr(), ptr.cast::<u8>(), NAME.len());
        ptr.cast::<u8>().add(NAME.len()).write(0);
    }
    1
}

/// v1-proven `effCanDo` answers: firmly no MIDI, unknown otherwise.
///
/// # Safety
///
/// `ptr` must be null or a NUL-terminated string.
unsafe fn can_do(ptr: *mut c_void) -> isize {
    if ptr.is_null() {
        return 0;
    }
    // SAFETY: per this function's contract.
    let capability = unsafe { CStr::from_ptr(ptr.cast()) };
    match capability.to_bytes() {
        b"receiveVstEvents" | b"receiveVstMidiEvent" => -1,
        _ => 0,
    }
}

/// `numParams` is 0 — every control lives in the Web UI.
unsafe extern "C" fn set_parameter(_effect: *mut AEffect, _index: i32, _parameter: f32) {}

/// `numParams` is 0 — every control lives in the Web UI.
unsafe extern "C" fn get_parameter(_effect: *mut AEffect, _index: i32) -> f32 {
    0.0
}

/// The host's per-block callback: convert float32 → int16 once, ferry
/// through the daemon, write the result back — or pass through dry.
unsafe extern "C" fn process_replacing(
    effect: *mut AEffect,
    inputs: *const *const f32,
    outputs: *mut *mut f32,
    sample_frames: i32,
) {
    let Ok(frames) = usize::try_from(sample_frames) else {
        return;
    };
    if frames == 0 || inputs.is_null() || outputs.is_null() {
        return;
    }
    // SAFETY: `effect` is ours; a stereo host passes two channel
    // pointers each way, each valid for `frames` samples.
    unsafe {
        let Some(shared) = shared(effect) else {
            return;
        };
        let (input_left, input_right) = (*inputs, *inputs.add(1));
        let (output_left, output_right) = (*outputs, *outputs.add(1));
        if input_left.is_null()
            || input_right.is_null()
            || output_left.is_null()
            || output_right.is_null()
        {
            return;
        }
        let mut effect_state = lock(shared);
        // Stage, then render: the input borrows end before the output
        // borrows begin, so in-place hosts (inputs == outputs —
        // EqualizerAPO's shape) never alias a live pair.
        effect_state.stage(
            std::slice::from_raw_parts(input_left, frames),
            std::slice::from_raw_parts(input_right, frames),
        );
        effect_state.render(
            std::slice::from_raw_parts_mut(output_left, frames),
            std::slice::from_raw_parts_mut(output_right, frames),
        );
    }
}
