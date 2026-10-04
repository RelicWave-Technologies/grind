//! macOS idle: `CGEventSourceSecondsSinceLastEventType(CombinedSessionState, AnyInput)`.
#![allow(
    clippy::unnecessary_wraps,
    reason = "every platform backend shares one fallible signature"
)]

use crate::mac_ffi;
use crate::{PlatformError, session};

/// Port of Chromium `ui::CalculateIdleTime()` (`ui/base/idle/idle_mac.mm`).
pub(super) fn idle_seconds() -> Result<i32, PlatformError> {
    // SAFETY: plain value arguments; the call has no preconditions.
    let raw = unsafe {
        mac_ffi::CGEventSourceSecondsSinceLastEventType(
            mac_ffi::K_CG_EVENT_SOURCE_STATE_COMBINED_SESSION_STATE,
            mac_ffi::K_CG_ANY_INPUT_EVENT_TYPE,
        )
    };
    Ok(super::mac_idle_seconds(raw))
}

/// Port of `ui::CheckIdleStateIsLocked()`: `screensaverRunning || screenLocked`.
pub(super) fn is_locked() -> Result<bool, PlatformError> {
    Ok(session::locked_or_screensaver())
}
