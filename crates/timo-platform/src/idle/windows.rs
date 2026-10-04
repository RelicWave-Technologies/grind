//! Windows idle: `GetLastInputInfo` + `GetTickCount`, as Chromium does.
#![allow(
    clippy::unnecessary_wraps,
    reason = "every platform backend shares one fallible signature"
)]

use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::WindowsAndMessaging::{
    SPI_GETSCREENSAVERRUNNING, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS, SystemParametersInfoW,
};

use crate::{PlatformError, session};

/// Port of Chromium `CalculateIdleTimeInternal` (`ui/base/idle/idle_win.cc`).
/// A failed `GetLastInputInfo` yields 0, exactly like Chromium.
pub(super) fn idle_seconds() -> Result<i32, PlatformError> {
    let Ok(cb_size) = u32::try_from(size_of::<LASTINPUTINFO>()) else {
        return Ok(0);
    };
    let mut info = LASTINPUTINFO {
        cbSize: cb_size,
        dwTime: 0,
    };
    // SAFETY: `info` is a valid, correctly sized LASTINPUTINFO for the call.
    if !unsafe { GetLastInputInfo(&raw mut info) }.as_bool() {
        return Ok(0);
    }
    // SAFETY: no arguments, no preconditions.
    let now = unsafe { GetTickCount() };
    Ok(super::windows_idle_seconds(info.dwTime, now))
}

/// Port of `CheckIdleStateIsLocked`: `IsWorkstationLocked() || IsScreensaverRunning()`.
pub(super) fn is_locked() -> Result<bool, PlatformError> {
    Ok(session::locked() || screensaver_running())
}

/// Chromium 130 queries this live on every call.
fn screensaver_running() -> bool {
    let mut running: u32 = 0;
    // SAFETY: `running` is a valid DWORD out-parameter for SPI_GETSCREENSAVERRUNNING.
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETSCREENSAVERRUNNING,
            0,
            Some((&raw mut running).cast()),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
    };
    ok.is_ok() && running != 0
}
