//! Windows power and session events: one hidden message-only window.
//!
//! Matches Electron 33.2.0's `electron_api_power_monitor_win.cc`:
//!
//! | event | message |
//! |---|---|
//! | `Suspend` | `WM_POWERBROADCAST` / `PBT_APMSUSPEND` |
//! | `Resume` | `WM_POWERBROADCAST` / `PBT_APMRESUMEAUTOMATIC` (never `PBT_APMRESUMESUSPEND`, which always follows it) |
//! | `LockScreen` / `UnlockScreen` | `WM_WTSSESSION_CHANGE` / `WTS_SESSION_LOCK` / `WTS_SESSION_UNLOCK`, current session only |
//!
//! There is **no `Shutdown` event on Windows**, exactly as in Electron 33 (whose
//! `powerMonitor` emits `shutdown` on Linux and macOS only). A message-only window
//! never receives `WM_QUERYENDSESSION` / `WM_ENDSESSION` — those are sent to
//! top-level windows — so none is claimed here. Session end on Windows is for the
//! app layer, which owns a top-level window (to be wired in the Tauri app).
//!
//! The window is registered for `WTSRegisterSessionNotification(NOTIFY_FOR_THIS_SESSION)`
//! and `RegisterSuspendResumeNotification(DEVICE_NOTIFY_WINDOW_HANDLE)` (the latter
//! is what delivers `PBT_APMSUSPEND` on Modern Standby machines).
//!
//! # Startup must not silently lose lock events
//!
//! `WTSRegisterSessionNotification` can fail with `RPC_S_INVALID_BINDING` when the
//! app autostarts at logon before the RPC services are ready. Start therefore
//! retries that one error with a bounded backoff (see
//! [`super::session_registration_retry_delay`], ≈ 7.75 s in all) and, if the
//! registration still fails or fails for any other reason, **returns the error and
//! tears everything down** instead of announcing a monitor that will never see a
//! lock. The caller owns any further retry. Unregistration happens on the owner
//! thread *before* the window is destroyed, as Microsoft requires.

use std::cell::Cell;
use std::ffi::c_void;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;
use std::sync::{Arc, mpsc};
use std::thread::JoinHandle;

use windows::Win32::Foundation::{HANDLE, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Power::{
    HPOWERNOTIFY, RegisterSuspendResumeNotification, UnregisterSuspendResumeNotification,
};
use windows::Win32::System::RemoteDesktop::{
    NOTIFY_FOR_THIS_SESSION, WTSRegisterSessionNotification, WTSUnRegisterSessionNotification,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CREATESTRUCTW, CreateWindowExW, DEVICE_NOTIFY_WINDOW_HANDLE, DefWindowProcW, DestroyWindow,
    DispatchMessageW, GWLP_USERDATA, GetMessageW, GetWindowLongPtrW, HWND_MESSAGE, MSG,
    PostMessageW, PostQuitMessage, RegisterClassExW, SetWindowLongPtrW, TranslateMessage,
    UnregisterClassW, WINDOW_EX_STYLE, WINDOW_STYLE, WM_CLOSE, WM_DESTROY, WM_NCCREATE,
    WM_POWERBROADCAST, WNDCLASSEXW,
};
use windows::core::{HRESULT, PCWSTR, w};

use super::win_session::{initial_session_locked, is_current_session};
use super::{PowerEvent, PowerSink, deliver, session_registration_retry_delay};
use crate::{PlatformError, session};

const CLASS_NAME: PCWSTR = w!("Timo_PowerMonitorHostWindow");

const WM_WTSSESSION_CHANGE: u32 = 0x02B1;
const WTS_SESSION_LOCK: usize = 0x7;
const WTS_SESSION_UNLOCK: usize = 0x8;
const PBT_APMSUSPEND: usize = 0x4;
const PBT_APMRESUMEAUTOMATIC: usize = 0x12;

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

/// `RPC_S_INVALID_BINDING`: the RPC service behind WTS is not up yet (early logon).
const RPC_S_INVALID_BINDING: u32 = 1702;

struct WindowCtx {
    sink: Arc<dyn PowerSink>,
    /// Registrations to undo on the owner thread while the window is still alive.
    session_registered: Cell<bool>,
    suspend_resume: Cell<Option<HPOWERNOTIFY>>,
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
    let ctx = Box::into_raw(Box::new(WindowCtx {
        sink,
        session_registered: Cell::new(false),
        suspend_resume: Cell::new(None),
    }));
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
    // SAFETY: `ctx` is the live Box created above; only this thread touches it until the pump ends.
    let registered = register_notifications(hwnd, unsafe { &*ctx });
    if let Err(error) = registered {
        // SAFETY: the window was created on this thread and nothing is registered; destroy it before freeing `ctx`.
        unsafe {
            DestroyWindow(hwnd).ok();
            UnregisterClassW(CLASS_NAME, Some(instance)).ok();
            drop(Box::from_raw(ctx));
        }
        ready.send(Err(error)).ok();
        return;
    }
    ready.send(Ok(Hwnd(hwnd))).ok();
    pump();
    // SAFETY: the window is destroyed and its notifications were unregistered in WM_CLOSE; free what is left.
    unsafe {
        UnregisterClassW(CLASS_NAME, Some(instance)).ok();
        drop(Box::from_raw(ctx));
    }
}

/// Register for lock/unlock (retrying the logon-time RPC race) and suspend/resume.
fn register_notifications(hwnd: HWND, ctx: &WindowCtx) -> Result<(), PlatformError> {
    register_session_notification(hwnd)?;
    ctx.session_registered.set(true);
    // SAFETY: `hwnd` is valid; DEVICE_NOTIFY_WINDOW_HANDLE means the recipient is a window handle.
    match unsafe { RegisterSuspendResumeNotification(HANDLE(hwnd.0), DEVICE_NOTIFY_WINDOW_HANDLE) }
    {
        Ok(handle) => ctx.suspend_resume.set(Some(handle)),
        Err(error) => tracing::warn!(
            %error,
            "RegisterSuspendResumeNotification failed; Modern Standby suspend may be missed"
        ),
    }
    Ok(())
}

fn register_session_notification(hwnd: HWND) -> Result<(), PlatformError> {
    let mut attempt = 0;
    loop {
        // SAFETY: `hwnd` is the window just created on this thread.
        let registered = unsafe { WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) };
        let Err(error) = registered else {
            return Ok(());
        };
        let transient = error.code() == HRESULT::from_win32(RPC_S_INVALID_BINDING);
        let Some(delay) = session_registration_retry_delay(transient, attempt) else {
            return Err(PlatformError::os("WTSRegisterSessionNotification", error));
        };
        tracing::info!(%error, ?delay, "WTS not ready yet; retrying session notification registration");
        std::thread::sleep(delay);
        attempt += 1;
    }
}

/// Undo the registrations. Must run on the owner thread with the window still alive:
/// Microsoft requires `WTSUnRegisterSessionNotification` *before* `DestroyWindow`.
fn unregister_notifications(hwnd: HWND, ctx: &WindowCtx) {
    if let Some(handle) = ctx.suspend_resume.take() {
        // SAFETY: `handle` came from RegisterSuspendResumeNotification and is released once.
        if let Err(error) = unsafe { UnregisterSuspendResumeNotification(handle) } {
            tracing::warn!(%error, "UnregisterSuspendResumeNotification failed");
        }
    }
    if ctx.session_registered.replace(false) {
        // SAFETY: `hwnd` was registered on this thread and has not been destroyed yet.
        if let Err(error) = unsafe { WTSUnRegisterSessionNotification(hwnd) } {
            tracing::warn!(%error, "WTSUnRegisterSessionNotification failed");
        }
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
    // SAFETY: a non-null user-data pointer is the WindowCtx kept alive by `run` until after the pump ends.
    let ctx = unsafe { ctx.as_ref() };
    let handled = ctx.and_then(|ctx| {
        catch_unwind(AssertUnwindSafe(|| handle(ctx, message, wparam, lparam))).unwrap_or(None)
    });
    if let Some(result) = handled {
        return result;
    }
    match message {
        WM_CLOSE => {
            if let Some(ctx) = ctx {
                unregister_notifications(hwnd, ctx);
            }
            // SAFETY: destroys this window on its own thread, after its notifications are gone.
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
