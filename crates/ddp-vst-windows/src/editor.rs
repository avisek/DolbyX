//! `effEditOpen` — the plugin has no editor of its own: it opens the
//! Web UI in the default browser (issue #21).

use std::ffi::c_void;

/// Where the daemon serves the UI — its default `--port` (the plugin
/// carries no configuration).
#[cfg(windows)]
const UI_URL: &str = "http://localhost:9876";

/// Opens the Web UI; `parent` is the host's editor window handle.
#[cfg(windows)]
pub fn open(parent: *mut c_void) {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GA_ROOT, GetAncestor, GetWindowTextW, PostMessageW, SW_SHOWNORMAL, WM_CLOSE,
    };

    let wide = |text: &str| text.encode_utf16().chain([0]).collect::<Vec<u16>>();
    let (operation, url) = (wide("open"), wide(UI_URL));
    // SAFETY: NUL-terminated wide strings; a null owner window, null
    // parameters, and a null directory are all allowed.
    unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            url.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        );
    }

    // v1-proven nicety: EqualizerAPO pops an empty editor window for
    // the click that got us here — dismiss that popup (it carries the
    // plugin's name), never the main Configuration Editor.
    if parent.is_null() {
        return;
    }
    // SAFETY: `parent` is the live editor window handle the host just
    // passed; the title buffer outlives the call that fills it.
    unsafe {
        let root = GetAncestor(parent.cast(), GA_ROOT);
        if root.is_null() {
            return;
        }
        let mut title = [0_u16; 64];
        let Ok(length) = usize::try_from(GetWindowTextW(root, title.as_mut_ptr(), 64)) else {
            return;
        };
        if String::from_utf16_lossy(&title[..length.min(64)]).contains("DolbyX") {
            PostMessageW(root, WM_CLOSE, 0, 0);
        }
    }
}

/// Non-Windows builds exist for the test harness only; the LV2 shim
/// (Slice 21, #29) brings the `xdg-open` flavor in its own crate.
#[cfg(not(windows))]
pub fn open(_parent: *mut c_void) {}
