//! The VST2 ABI — the publicly documented C interface, no SDK.
//!
//! Translated from v1's proven header (`git show
//! v1:windows/vst/vst2_abi.h`, the DLL EqualizerAPO ran daily); only
//! the surface the DolbyX shim and its synthetic host touch. Original
//! (camelCase) names ride each item's doc for greppability against
//! VST2 literature.

use std::ffi::c_void;

/// `kEffectMagic` — `'VstP'`; the first field every host checks.
pub const EFFECT_MAGIC: i32 = 0x5673_7450;
/// `kVstVersion` — the VST 2.4 protocol version.
pub const VST_VERSION: isize = 2400;

/// `effOpen` — instance initialization, first dispatcher call.
pub const EFF_OPEN: i32 = 0;
/// `effClose` — final dispatcher call; the instance frees itself.
pub const EFF_CLOSE: i32 = 1;
/// `effSetSampleRate` — the processing rate arrives in `opt`.
pub const EFF_SET_SAMPLE_RATE: i32 = 10;
/// `effSetBlockSize` — the host's maximum block, in `value`
/// (informational here: blocks are ferried in bounded chunks).
pub const EFF_SET_BLOCK_SIZE: i32 = 11;
/// `effMainsChanged` — `value` 1 is resume, 0 is suspend.
pub const EFF_MAINS_CHANGED: i32 = 12;
/// `effEditGetRect` — writes an `ERect*` through `ptr`.
pub const EFF_EDIT_GET_RECT: i32 = 13;
/// `effEditOpen` — open the editor under the parent window in `ptr`.
pub const EFF_EDIT_OPEN: i32 = 14;
/// `effEditClose` — close the editor.
pub const EFF_EDIT_CLOSE: i32 = 15;
/// `effEditIdle` — editor idle tick.
pub const EFF_EDIT_IDLE: i32 = 19;
/// `effGetPlugCategory` — returns a `kPlugCateg…` value.
pub const EFF_GET_PLUG_CATEGORY: i32 = 35;
/// `effGetEffectName` — writes the effect name (≤ 32 bytes) to `ptr`.
pub const EFF_GET_EFFECT_NAME: i32 = 45;
/// `effGetVendorString` — writes the vendor (≤ 64 bytes) to `ptr`.
pub const EFF_GET_VENDOR_STRING: i32 = 47;
/// `effGetProductString` — writes the product (≤ 64 bytes) to `ptr`.
pub const EFF_GET_PRODUCT_STRING: i32 = 48;
/// `effGetVendorVersion` — returns the plugin's own version.
pub const EFF_GET_VENDOR_VERSION: i32 = 49;
/// `effCanDo` — `ptr` names a capability; −1 no, 0 unknown, 1 yes.
pub const EFF_CAN_DO: i32 = 51;
/// `effGetVstVersion` — returns [`VST_VERSION`].
pub const EFF_GET_VST_VERSION: i32 = 58;

/// `audioMasterVersion` — host-callback opcode probing the host's VST
/// version; a live host answers non-zero.
pub const AUDIO_MASTER_VERSION: i32 = 1;

/// `effFlagsHasEditor` — [`EFF_EDIT_OPEN`] is meaningful.
pub const EFF_FLAGS_HAS_EDITOR: i32 = 1;
/// `effFlagsCanReplacing` — `processReplacing` is implemented.
pub const EFF_FLAGS_CAN_REPLACING: i32 = 1 << 4;

/// `kPlugCategEffect` — a plain audio effect.
pub const PLUG_CATEG_EFFECT: isize = 1;

/// `ERect` — the editor bounds `effEditGetRect` reports.
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct ERect {
    /// Top edge, pixels.
    pub top: i16,
    /// Left edge, pixels.
    pub left: i16,
    /// Bottom edge, pixels.
    pub bottom: i16,
    /// Right edge, pixels.
    pub right: i16,
}

/// `audioMasterCallback` — the host services plugin requests here;
/// nullable on the wire, so optional here.
pub type AudioMasterCallback = Option<
    unsafe extern "C" fn(
        effect: *mut AEffect,
        opcode: i32,
        index: i32,
        value: isize,
        ptr: *mut c_void,
        opt: f32,
    ) -> isize,
>;

/// `AEffectDispatcherProc` — the plugin's opcode surface.
pub type DispatcherProc = unsafe extern "C" fn(
    effect: *mut AEffect,
    opcode: i32,
    index: i32,
    value: isize,
    ptr: *mut c_void,
    opt: f32,
) -> isize;

/// `AEffectProcessProc` — one float32 block; `inputs`/`outputs` are
/// per-channel pointer arrays (`numInputs`/`numOutputs` long).
pub type ProcessProc = unsafe extern "C" fn(
    effect: *mut AEffect,
    inputs: *const *const f32,
    outputs: *mut *mut f32,
    sample_frames: i32,
);

/// The float64 sibling of [`ProcessProc`] (unimplemented here).
pub type ProcessDoubleProc = unsafe extern "C" fn(
    effect: *mut AEffect,
    inputs: *const *const f64,
    outputs: *mut *mut f64,
    sample_frames: i32,
);

/// `AEffectSetParameterProc` — automatable-parameter write.
pub type SetParameterProc = unsafe extern "C" fn(effect: *mut AEffect, index: i32, parameter: f32);

/// `AEffectGetParameterProc` — automatable-parameter read.
pub type GetParameterProc = unsafe extern "C" fn(effect: *mut AEffect, index: i32) -> f32;

/// `AEffect` — the struct a VST2 host drives a plugin through. Layout
/// is ABI law (pinned by [`tests`]); field meanings per the v1 header.
#[repr(C)]
pub struct AEffect {
    /// Must be [`EFFECT_MAGIC`].
    pub magic: i32,
    /// The opcode surface.
    pub dispatcher: Option<DispatcherProc>,
    /// Deprecated accumulating process — never provided.
    pub process_deprecated: Option<ProcessProc>,
    /// Parameter write (this plugin exposes zero parameters).
    pub set_parameter: Option<SetParameterProc>,
    /// Parameter read (this plugin exposes zero parameters).
    pub get_parameter: Option<GetParameterProc>,
    /// Preset count.
    pub num_programs: i32,
    /// Automatable-parameter count.
    pub num_params: i32,
    /// Input channel count.
    pub num_inputs: i32,
    /// Output channel count.
    pub num_outputs: i32,
    /// `effFlags…` bits.
    pub flags: i32,
    /// Host-reserved.
    pub resvd1: isize,
    /// Host-reserved.
    pub resvd2: isize,
    /// Reported latency in samples.
    pub initial_delay: i32,
    /// Deprecated (`realQualities`) — zero.
    pub real_qualities: i32,
    /// Deprecated (`offQualities`) — zero.
    pub off_qualities: i32,
    /// Deprecated (`ioRatio`) — zero.
    pub io_ratio: f32,
    /// The plugin's own state; hosts never touch it.
    pub object: *mut c_void,
    /// Plugin-reserved; unused.
    pub user: *mut c_void,
    /// The registered four-byte plugin id.
    pub unique_id: i32,
    /// The plugin's own version.
    pub version: i32,
    /// The in-place float32 process — the path EqualizerAPO drives.
    pub process_replacing: Option<ProcessProc>,
    /// The float64 process — never provided.
    pub process_double_replacing: Option<ProcessDoubleProc>,
    /// ABI reserve — zeroed.
    pub future: [u8; 56],
}

#[cfg(test)]
mod tests {
    use std::mem::{offset_of, size_of};

    use super::*;

    /// The repr(C) translation must match the C header the hosts were
    /// built against — sizes/offsets from the v1 header's layout on
    /// `x86_64` (the shipped DLL's only target).
    #[test]
    #[cfg(target_pointer_width = "64")]
    fn aeffect_layout_matches_the_c_abi() {
        assert_eq!(size_of::<AEffect>(), 192);
        assert_eq!(offset_of!(AEffect, dispatcher), 8);
        assert_eq!(offset_of!(AEffect, num_programs), 40);
        assert_eq!(offset_of!(AEffect, flags), 56);
        assert_eq!(offset_of!(AEffect, initial_delay), 80);
        assert_eq!(offset_of!(AEffect, object), 96);
        assert_eq!(offset_of!(AEffect, unique_id), 112);
        assert_eq!(offset_of!(AEffect, process_replacing), 120);
        assert_eq!(offset_of!(AEffect, future), 136);
        assert_eq!(size_of::<ERect>(), 8);
    }

    /// `'VstP'` big-endian in the i32, as every host compares it.
    #[test]
    fn effect_magic_spells_vstp() {
        assert_eq!(EFFECT_MAGIC.to_be_bytes(), *b"VstP");
    }
}
