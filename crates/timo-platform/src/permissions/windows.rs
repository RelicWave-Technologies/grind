//! Windows: nothing to grant. Legacy returns `granted` / `true` for every
//! non-macOS platform; the one opener it has is `ms-settings:startupapps`.
//!
//! One known limitation carries over from legacy: a non-elevated process gets no
//! input events while a UAC-elevated window has focus, so counts under-report
//! for admin apps. Fixing it would mean running Timo elevated, which it will not.
#![allow(
    clippy::unnecessary_wraps,
    reason = "every platform backend shares one fallible signature"
)]

use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
use windows::core::{PCWSTR, w};

use super::{OpenOutcome, SettingsPane, windows_settings_url};
use crate::PlatformError;

pub(super) fn accessibility_trusted(_prompt: bool) -> Result<bool, PlatformError> {
    Ok(true)
}

pub(super) fn input_monitoring_granted() -> Result<bool, PlatformError> {
    Ok(true)
}

pub(super) fn request_input_monitoring() -> Result<bool, PlatformError> {
    Ok(true)
}

pub(super) fn screen_recording_granted() -> Result<bool, PlatformError> {
    Ok(true)
}

pub(super) fn request_screen_recording() -> Result<bool, PlatformError> {
    Ok(true)
}

/// `shell.openExternal(url)` on Windows is `ShellExecuteW(NULL, "open", url, …)`;
/// a result above 32 means success.
pub(super) fn open_settings(pane: SettingsPane) -> Result<OpenOutcome, PlatformError> {
    let Some(url) = windows_settings_url(pane) else {
        return Ok(OpenOutcome::NotApplicable);
    };
    let wide: Vec<u16> = url.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: `wide` is a NUL-terminated UTF-16 string that outlives the call.
    let result = unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            PCWSTR(wide.as_ptr()),
            None,
            None,
            SW_SHOWNORMAL,
        )
    };
    if result.0.addr() > 32 {
        Ok(OpenOutcome::Opened)
    } else {
        Err(PlatformError::os(
            "ShellExecuteW",
            format!("{url} returned {}", result.0.addr()),
        ))
    }
}
