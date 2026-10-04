//! Session-state queries for the Windows power monitor: is the workstation locked
//! right now, and is a `WM_WTSSESSION_CHANGE` about our session? Split from
//! `windows.rs` to keep both files small.

use std::ptr;

use windows::Win32::System::RemoteDesktop::{
    ProcessIdToSessionId, WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION, WTSFreeMemory,
    WTSINFOEXW, WTSQuerySessionInformationW, WTSSessionInfoEx,
};
use windows::Win32::System::Threading::GetCurrentProcessId;
use windows::core::PWSTR;

/// `WTS_SESSIONSTATE_LOCK`.
const SESSION_STATE_LOCK: i32 = 0;

/// Chromium's `IsSessionLocked()`: `WTSInfoEx` session flags equal `WTS_SESSIONSTATE_LOCK`.
#[allow(
    clippy::cast_ptr_alignment,
    reason = "the buffer is read with `read_unaligned`"
)]
pub(super) fn initial_session_locked() -> bool {
    let mut buffer = PWSTR::null();
    let mut bytes: u32 = 0;
    // SAFETY: out-parameters are valid locals; the returned buffer is freed with WTSFreeMemory below.
    let queried = unsafe {
        WTSQuerySessionInformationW(
            Some(WTS_CURRENT_SERVER_HANDLE),
            WTS_CURRENT_SESSION,
            WTSSessionInfoEx,
            &raw mut buffer,
            &raw mut bytes,
        )
    };
    if queried.is_err() || buffer.is_null() {
        return false;
    }
    let big_enough = usize::try_from(bytes).is_ok_and(|n| n >= size_of::<WTSINFOEXW>());
    let locked = big_enough && {
        // SAFETY: the buffer holds at least a WTSINFOEXW, per the size check above; read unaligned to be safe.
        let info = unsafe { ptr::read_unaligned(buffer.0.cast::<WTSINFOEXW>()) };
        // SAFETY: Level 1 is the only level WTSInfoEx defines.
        unsafe { info.Data.WTSInfoExLevel1.SessionFlags == SESSION_STATE_LOCK }
    };
    // SAFETY: frees the buffer WTSQuerySessionInformationW allocated.
    unsafe { WTSFreeMemory(buffer.0.cast()) };
    locked
}

/// Electron's `ProcessIdToSessionId` comparison; if the call fails, assume current.
pub(super) fn is_current_session(session_id: usize) -> bool {
    let mut current: u32 = 0;
    // SAFETY: `current` is a valid out-parameter.
    if unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &raw mut current) }.is_err() {
        return true;
    }
    usize::try_from(current).is_ok_and(|c| c == session_id)
}
