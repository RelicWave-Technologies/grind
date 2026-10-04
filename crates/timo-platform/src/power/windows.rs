//! Windows power and session events: one hidden message-only window.
//!
//! Matches Electron 33.2.0's `electron_api_power_monitor_win.cc`:
//!
//! | event | message |
//! |---|---|
//! | `Suspend` | `WM_POWERBROADCAST` / `PBT_APMSUSPEND` |
//! | `Resume` | `WM_POWERBROADCAST` / `PBT_APMRESUMEAUTOMATIC` (never `PBT_APMRESUMESUSPEND`, which always follows it) |
//! | `LockScreen` / `UnlockScreen` | `WM_WTSSESSION_CHANGE` / `WTS_SESSION_LOCK` / `WTS_SESSION_UNLOCK`, current session only |
//! | `Shutdown` | `WM_ENDSESSION` with `wParam != 0` (Electron emits no `shutdown` on Windows; this is a superset) |
//!
//! The window is registered for `WTSRegisterSessionNotification(NOTIFY_FOR_THIS_SESSION)`
//! and `RegisterSuspendResumeNotification(DEVICE_NOTIFY_WINDOW_HANDLE)` (the latter
//! is what delivers `PBT_APMSUSPEND` on Modern Standby machines). `WM_QUERYENDSESSION`
//! is always answered "yes": this app never vetoes a shutdown.

use std::ffi::c_void;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;
use std::sync::{Arc, mpsc};
use std::thread::JoinHandle;

use windows::Win32::Foundation::{HANDLE, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Power::{
    RegisterSuspendResumeNotification, UnregisterSuspendResumeNotification,
};
use windows::Win32::System::RemoteDesktop::{
    NOTIFY_FOR_THIS_SESSION, ProcessIdToSessionId, WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION,
    WTSFreeMemory, WTSINFOEXW, WTSQuerySessionInformationW, WTSRegisterSessionNotification,
    WTSSessionInfoEx, WTSUnRegisterSessionNotification,
};
use windows::Win32::System::Threading::GetCurrentProcessId;
use windows::Win32::UI::WindowsAndMessaging::{
    CREATESTRUCTW, CreateWindowExW, DEVICE_NOTIFY_WINDOW_HANDLE, DefWindowProcW, DestroyWindow,
    DispatchMessageW, GWLP_USERDATA, GetMessageW, GetWindowLongPtrW, HWND_MESSAGE, MSG,
    PostMessageW, PostQuitMessage, RegisterClassExW, SetWindowLongPtrW, TranslateMessage,
    UnregisterClassW, WINDOW_EX_STYLE, WINDOW_STYLE, WM_CLOSE, WM_DESTROY, WM_ENDSESSION,
    WM_NCCREATE, WM_POWERBROADCAST, WM_QUERYENDSESSION, WNDCLASSEXW,
};
use windows::core::{PCWSTR, PWSTR, w};

use super::{PowerEvent, PowerSink, deliver};
use crate::{PlatformError, session};

const CLASS_NAME: PCWSTR = w!("Timo_PowerMonitorHostWindow");

const WM_WTSSESSION_CHANGE: u32 = 0x02B1;
const WTS_SESSION_LOCK: usize = 0x7;
const WTS_SESSION_UNLOCK: usize = 0x8;
const PBT_APMSUSPEND: usize = 0x4;
const PBT_APMRESUMEAUTOMATIC: usize = 0x12;
/// `WTS_SESSIONSTATE_LOCK`.
const SESSION_STATE_LOCK: i32 = 0;

/// What a window message means for our consumers. Pure, so it tests anywhere.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Interpretation {
    Emit(PowerEvent),
    /// A lock/unlock for another session, or a message we do not care about.
    Ignore,
}

/// `WM_POWERBROADCAST` wParam → event (Electron: only these two are handled).
pub(crate) fn interpret_power_broadcast(wparam: usize) -> Interpretation {
    match wparam {
        PBT_APMSUSPEND => Interpretation::Emit(PowerEvent::Suspend),
        PBT_APMRESUMEAUTOMATIC => Interpretation::Emit(PowerEvent::Resume),
        _ => Interpretation::Ignore,
    }
}

/// `WM_WTSSESSION_CHANGE` → event, for the session that matters.
pub(crate) fn interpret_session_change(wparam: usize, is_current_session: bool) -> Interpretation {
    if !is_current_session {
        return Interpretation::Ignore;
    }
    match wparam {
        WTS_SESSION_LOCK => Interpretation::Emit(PowerEvent::LockScreen),
        WTS_SESSION_UNLOCK => Interpretation::Emit(PowerEvent::UnlockScreen),
        _ => Interpretation::Ignore,
    }
}

struct WindowCtx {
    sink: Arc<dyn PowerSink>,
}

#[derive(Clone, Copy, Debug)]
struct Hwnd(HWND);

// SAFETY: only `PostMessageW` is called with it from other threads, which is safe for any window.
unsafe impl Send for Hwnd {}

#[derive(Debug)]
pub(super) struct Backend {
    hwnd: Hwnd,
    thread: Option<JoinHandle<()>>,
}

impl Backend {
    pub(super) fn start(sink: Arc<dyn PowerSink>) -> Result<Self, PlatformError> {
        let (ready_tx, ready_rx) = mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("timo-power-events".to_owned())
            .spawn(move || run(sink, &ready_tx))
            .map_err(|e| PlatformError::os("spawn power monitor thread", e))?;
        match ready_rx.recv() {
            Ok(Ok(hwnd)) => Ok(Self {
                hwnd,
                thread: Some(thread),
            }),
            Ok(Err(error)) => {
                thread.join().ok();
                Err(error)
            }
            Err(_) => {
                thread.join().ok();
                Err(PlatformError::os(
                    "power monitor thread",
                    "exited before it was ready",
                ))
            }
        }
    }

    pub(super) fn stop(&mut self) {
        // SAFETY: posts WM_CLOSE to the window owned by the thread we have not joined yet.
        if unsafe { PostMessageW(Some(self.hwnd.0), WM_CLOSE, WPARAM(0), LPARAM(0)) }.is_err() {
            tracing::warn!("could not post WM_CLOSE to the power monitor window");
        }
        if let Some(thread) = self.thread.take() {
            thread.join().ok();
        }
    }
}

fn run(sink: Arc<dyn PowerSink>, ready: &mpsc::Sender<Result<Hwnd, PlatformError>>) {
    let ctx = Box::into_raw(Box::new(WindowCtx { sink }));
    let (hwnd, instance) = match create_window(ctx) {
        Ok(created) => created,
        Err(error) => {
            // SAFETY: the window was never created, so nothing else holds `ctx`.
            drop(unsafe { Box::from_raw(ctx) });
            ready.send(Err(error)).ok();
            return;
        }
    };
    session::set_locked(initial_session_locked());
    // SAFETY: `hwnd` is the window just created on this thread.
    let session_registered =
        unsafe { WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) };
    if session_registered.is_err() {
        tracing::warn!("WTSRegisterSessionNotification failed; lock/unlock events will not arrive");
    }
    // SAFETY: `hwnd` is valid; DEVICE_NOTIFY_WINDOW_HANDLE means the recipient is a window handle.
    let power_handle =
        unsafe { RegisterSuspendResumeNotification(HANDLE(hwnd.0), DEVICE_NOTIFY_WINDOW_HANDLE) };
    if power_handle.is_err() {
        tracing::warn!(
            "RegisterSuspendResumeNotification failed; Modern Standby suspend may be missed"
        );
    }
    ready.send(Ok(Hwnd(hwnd))).ok();
    pump();
    // SAFETY: unregister what was registered above; the window is already destroyed.
    unsafe {
        if let Ok(handle) = power_handle {
            UnregisterSuspendResumeNotification(handle).ok();
        }
        if session_registered.is_ok() {
            WTSUnRegisterSessionNotification(hwnd).ok();
        }
        UnregisterClassW(CLASS_NAME, Some(instance)).ok();
        drop(Box::from_raw(ctx));
    }
}

fn pump() {
    let mut msg = MSG::default();
    loop {
        // SAFETY: `msg` is a valid MSG for the call.
        let got = unsafe { GetMessageW(&raw mut msg, None, 0, 0) };
        if got.0 <= 0 {
            break;
        }
        // SAFETY: `msg` was just filled by GetMessageW.
        unsafe {
            TranslateMessage(&raw const msg).as_bool();
            DispatchMessageW(&raw const msg);
        }
    }
}

fn create_window(ctx: *mut WindowCtx) -> Result<(HWND, HINSTANCE), PlatformError> {
    // SAFETY: null module name asks for the current executable's handle.
    let module =
        unsafe { GetModuleHandleW(None) }.map_err(|e| PlatformError::os("GetModuleHandleW", e))?;
    let instance = HINSTANCE(module.0);
    let class = WNDCLASSEXW {
        cbSize: u32::try_from(size_of::<WNDCLASSEXW>()).unwrap_or(0),
        lpfnWndProc: Some(window_proc),
        hInstance: instance,
        lpszClassName: CLASS_NAME,
        ..WNDCLASSEXW::default()
    };
    // SAFETY: `class` is fully initialised and its name/proc are 'static.
    if unsafe { RegisterClassExW(&raw const class) } == 0 {
        return Err(PlatformError::os(
            "RegisterClassExW",
            windows::core::Error::from_thread(),
        ));
    }
    // SAFETY: HWND_MESSAGE makes a message-only window; `ctx` is the creation parameter and outlives it.
    let created = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            CLASS_NAME,
            w!(""),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(instance),
            Some(ctx.cast::<c_void>().cast_const()),
        )
    };
    match created {
        Ok(hwnd) => Ok((hwnd, instance)),
        Err(e) => {
            // SAFETY: undo the class registration above.
            unsafe { UnregisterClassW(CLASS_NAME, Some(instance)) }.ok();
            Err(PlatformError::os("CreateWindowExW", e))
        }
    }
}

/// Chromium's `IsSessionLocked()`: `WTSInfoEx` session flags equal `WTS_SESSIONSTATE_LOCK`.
#[allow(
    clippy::cast_ptr_alignment,
    reason = "the buffer is read with `read_unaligned`"
)]
fn initial_session_locked() -> bool {
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
fn is_current_session(session_id: usize) -> bool {
    let mut current: u32 = 0;
    // SAFETY: `current` is a valid out-parameter.
    if unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &raw mut current) }.is_err() {
        return true;
    }
    usize::try_from(current).is_ok_and(|c| c == session_id)
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_NCCREATE {
        let address = usize::from_ne_bytes(lparam.0.to_ne_bytes());
        // SAFETY: for WM_NCCREATE, lParam points at the CREATESTRUCTW holding our creation parameter.
        let create = unsafe { &*ptr::with_exposed_provenance::<CREATESTRUCTW>(address) };
        let params = create.lpCreateParams.addr();
        // SAFETY: stores our context pointer in the window's user data for later messages.
        unsafe {
            SetWindowLongPtrW(
                hwnd,
                GWLP_USERDATA,
                isize::from_ne_bytes(params.to_ne_bytes()),
            )
        };
        // SAFETY: default handling continues window creation.
        return unsafe { DefWindowProcW(hwnd, message, wparam, lparam) };
    }
    // SAFETY: reads back the pointer stored at WM_NCCREATE (null before that).
    let raw = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) };
    let ctx = ptr::with_exposed_provenance::<WindowCtx>(usize::from_ne_bytes(raw.to_ne_bytes()));
    let handled = if ctx.is_null() {
        None
    } else {
        // SAFETY: a non-null user-data pointer is the WindowCtx kept alive by `run` until after the pump ends.
        let ctx = unsafe { &*ctx };
        catch_unwind(AssertUnwindSafe(|| handle(ctx, message, wparam, lparam))).unwrap_or(None)
    };
    if let Some(result) = handled {
        return result;
    }
    match message {
        WM_CLOSE => {
            // SAFETY: destroys this window on its own thread.
            unsafe { DestroyWindow(hwnd) }.ok();
            LRESULT(0)
        }
        WM_DESTROY => {
            // SAFETY: ends this thread's pump.
            unsafe { PostQuitMessage(0) };
            LRESULT(0)
        }
        // SAFETY: default handling for everything else.
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}

fn handle(ctx: &WindowCtx, message: u32, wparam: WPARAM, lparam: LPARAM) -> Option<LRESULT> {
    match message {
        WM_POWERBROADCAST => {
            if let Interpretation::Emit(event) = interpret_power_broadcast(wparam.0) {
                deliver(&*ctx.sink, event);
            }
            Some(LRESULT(1))
        }
        WM_WTSSESSION_CHANGE => {
            let current = is_current_session(usize::from_ne_bytes(lparam.0.to_ne_bytes()));
            if let Interpretation::Emit(event) = interpret_session_change(wparam.0, current) {
                session::set_locked(event == PowerEvent::LockScreen);
                deliver(&*ctx.sink, event);
            }
            Some(LRESULT(0))
        }
        WM_QUERYENDSESSION => Some(LRESULT(1)),
        WM_ENDSESSION => {
            if wparam.0 != 0 {
                deliver(&*ctx.sink, PowerEvent::Shutdown);
            }
            Some(LRESULT(0))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_suspend_and_automatic_resume_are_handled() {
        assert_eq!(
            interpret_power_broadcast(0x4),
            Interpretation::Emit(PowerEvent::Suspend)
        );
        assert_eq!(
            interpret_power_broadcast(0x12),
            Interpretation::Emit(PowerEvent::Resume)
        );
        // PBT_APMRESUMESUSPEND (0x7) always follows AUTOMATIC; PBT_APMPOWERSTATUSCHANGE (0xA) is not ours.
        assert_eq!(interpret_power_broadcast(0x7), Interpretation::Ignore);
        assert_eq!(interpret_power_broadcast(0xA), Interpretation::Ignore);
    }

    #[test]
    fn lock_and_unlock_count_only_for_the_current_session() {
        assert_eq!(
            interpret_session_change(0x7, true),
            Interpretation::Emit(PowerEvent::LockScreen)
        );
        assert_eq!(
            interpret_session_change(0x8, true),
            Interpretation::Emit(PowerEvent::UnlockScreen)
        );
        assert_eq!(interpret_session_change(0x7, false), Interpretation::Ignore);
        assert_eq!(
            interpret_session_change(0x1, true),
            Interpretation::Ignore,
            "console connect"
        );
    }
}
