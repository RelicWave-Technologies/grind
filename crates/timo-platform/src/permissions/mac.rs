//! macOS permission calls: the same APIs Electron's `systemPreferences` uses.
#![allow(
    clippy::unnecessary_wraps,
    reason = "every platform backend shares one fallible signature"
)]

use std::process::Command;

use super::{OpenOutcome, SettingsPane, mac_settings_url};
use crate::PlatformError;
use crate::mac_ffi as ffi;

/// `AXIsProcessTrustedWithOptions({kAXTrustedCheckOptionPrompt: prompt})`,
/// exactly Electron's `IsTrustedAccessibilityClient`.
pub(super) fn accessibility_trusted(prompt: bool) -> Result<bool, PlatformError> {
    // SAFETY: the CF constants are process-lifetime statics; the dictionary is created and released here.
    unsafe {
        let key: ffi::CFTypeRef = ffi::kAXTrustedCheckOptionPrompt;
        let value = if prompt {
            ffi::kCFBooleanTrue
        } else {
            ffi::kCFBooleanFalse
        };
        let options = ffi::CFDictionaryCreate(
            std::ptr::null(),
            &raw const key,
            &raw const value,
            1,
            &raw const ffi::kCFTypeDictionaryKeyCallBacks,
            &raw const ffi::kCFTypeDictionaryValueCallBacks,
        );
        if options.is_null() {
            return Err(PlatformError::os("CFDictionaryCreate", "returned null"));
        }
        let trusted = ffi::AXIsProcessTrustedWithOptions(options);
        ffi::CFRelease(options);
        Ok(trusted)
    }
}

pub(super) fn input_monitoring_granted() -> Result<bool, PlatformError> {
    // SAFETY: no arguments, no preconditions.
    Ok(unsafe { ffi::CGPreflightListenEventAccess() })
}

pub(super) fn request_input_monitoring() -> Result<bool, PlatformError> {
    // SAFETY: no arguments; may show the system prompt.
    Ok(unsafe { ffi::CGRequestListenEventAccess() })
}

pub(super) fn screen_recording_granted() -> Result<bool, PlatformError> {
    // SAFETY: no arguments, no preconditions.
    Ok(unsafe { ffi::CGPreflightScreenCaptureAccess() })
}

pub(super) fn request_screen_recording() -> Result<bool, PlatformError> {
    // SAFETY: no arguments; may show the system prompt.
    Ok(unsafe { ffi::CGRequestScreenCaptureAccess() })
}

/// `shell.openExternal(url)` on macOS is `open <url>` (`LaunchServices`).
pub(super) fn open_settings(pane: SettingsPane) -> Result<OpenOutcome, PlatformError> {
    let url = mac_settings_url(pane);
    let status = Command::new("/usr/bin/open")
        .arg(url)
        .status()
        .map_err(|e| PlatformError::os("open System Settings", e))?;
    if status.success() {
        Ok(OpenOutcome::Opened)
    } else {
        Err(PlatformError::os(
            "open System Settings",
            format!("`open {url}` exited with {status}"),
        ))
    }
}
