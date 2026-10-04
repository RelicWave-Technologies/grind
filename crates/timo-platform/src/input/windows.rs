//! Windows input counting: `WH_KEYBOARD_LL` + `WH_MOUSE_LL` on one thread with a
//! `GetMessageW` pump — what libuiohook does.
//!
//! Hook callbacks return fast: decode one message, queue one event, call the next
//! hook. They never block, never consume the event, and never read a virtual-key
//! code — the keyboard hook looks at the message type alone.
//!
//! Hook procedures have no user-data slot, so the sender lives in a process-wide
//! slot; `InputListener` guarantees only one listener exists at a time.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;
use std::sync::{Arc, Mutex, mpsc};
use std::thread::JoinHandle;

use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, HC_ACTION, HHOOK, MSG, MSLLHOOKSTRUCT,
    PM_NOREMOVE, PeekMessageW, PostThreadMessageW, SetWindowsHookExW, TranslateMessage,
    UnhookWindowsHookEx, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_QUIT, WM_USER,
};

use super::decide::{WinMouseState, decode_win_key};
use super::{EventTx, InputPermission, Shared};
use crate::PlatformError;

struct HookState {
    tx: EventTx,
    mouse: WinMouseState,
}

static STATE: Mutex<Option<HookState>> = Mutex::new(None);

#[derive(Debug)]
pub(super) struct Backend {
    thread_id: u32,
    thread: Option<JoinHandle<()>>,
}

impl Backend {
    pub(super) fn start(tx: EventTx, shared: Arc<Shared>) -> Result<Self, PlatformError> {
        let (ready_tx, ready_rx) = mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("timo-input-hooks".to_owned())
            .spawn(move || run(tx, &shared, &ready_tx))
            .map_err(|e| PlatformError::os("spawn input hook thread", e))?;
        match ready_rx.recv() {
            Ok(Ok(thread_id)) => Ok(Self {
                thread_id,
                thread: Some(thread),
            }),
            Ok(Err(error)) => {
                thread.join().ok();
                Err(error)
            }
            Err(_) => {
                thread.join().ok();
                Err(PlatformError::os(
                    "input hook thread",
                    "exited before it was ready",
                ))
            }
        }
    }

    pub(super) fn stop(&mut self) {
        // SAFETY: posts WM_QUIT to the pump thread we spawned and have not joined yet.
        let posted = unsafe { PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0)) };
        if posted.is_err() {
            tracing::warn!("could not post WM_QUIT to the input hook thread");
        }
        if let Some(thread) = self.thread.take() {
            thread.join().ok();
        }
    }
}

fn run(tx: EventTx, shared: &Shared, ready: &mpsc::Sender<Result<u32, PlatformError>>) {
    set_state(Some(HookState {
        tx,
        mouse: WinMouseState::default(),
    }));
    let hooks = match install() {
        Ok(hooks) => hooks,
        Err(error) => {
            shared.set_error(Some(error.to_string()));
            set_state(None);
            ready.send(Err(error)).ok();
            return;
        }
    };
    shared.set_permission(InputPermission::NotRequired);
    shared.set_error(None);
    // Force this thread's message queue into existence so WM_QUIT can be posted to it.
    let mut msg = MSG::default();
    // SAFETY: `msg` is a valid MSG; PM_NOREMOVE leaves the (empty) queue untouched.
    unsafe { PeekMessageW(&raw mut msg, None, WM_USER, WM_USER, PM_NOREMOVE) }.as_bool();
    // SAFETY: no arguments.
    let thread_id = unsafe { GetCurrentThreadId() };
    ready.send(Ok(thread_id)).ok();
    pump();
    // SAFETY: both hooks were installed on this thread by `install` and are removed once.
    unsafe {
        UnhookWindowsHookEx(hooks.0).ok();
        UnhookWindowsHookEx(hooks.1).ok();
    }
    set_state(None);
}

/// The message pump the low-level hooks require: they are only called while this
/// thread is retrieving messages.
fn pump() {
    let mut msg = MSG::default();
    loop {
        // SAFETY: `msg` is a valid MSG for the call.
        let got = unsafe { GetMessageW(&raw mut msg, None, 0, 0) };
        if got.0 <= 0 {
            break; // 0 = WM_QUIT, -1 = error
        }
        // SAFETY: `msg` was just filled by GetMessageW.
        unsafe {
            TranslateMessage(&raw const msg).as_bool();
            DispatchMessageW(&raw const msg);
        }
    }
}

fn install() -> Result<(HHOOK, HHOOK), PlatformError> {
    // SAFETY: null module name asks for the current executable's handle.
    let module =
        unsafe { GetModuleHandleW(None) }.map_err(|e| PlatformError::os("GetModuleHandleW", e))?;
    let instance = HINSTANCE(module.0);
    // SAFETY: the procs are `extern "system"` functions with the HOOKPROC signature and 'static lifetime.
    let keyboard =
        unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), Some(instance), 0) }
            .map_err(|e| PlatformError::os("SetWindowsHookExW(WH_KEYBOARD_LL)", e))?;
    // SAFETY: as above.
    match unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), Some(instance), 0) } {
        Ok(mouse) => Ok((keyboard, mouse)),
        Err(e) => {
            // SAFETY: undo the keyboard hook installed a moment ago.
            unsafe { UnhookWindowsHookEx(keyboard) }.ok();
            Err(PlatformError::os("SetWindowsHookExW(WH_MOUSE_LL)", e))
        }
    }
}

fn set_state(state: Option<HookState>) {
    if let Ok(mut slot) = STATE.lock() {
        *slot = state;
    }
}

unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if u32::try_from(code) == Ok(HC_ACTION) {
        catch_unwind(AssertUnwindSafe(|| {
            let message = u32::try_from(wparam.0).unwrap_or(0);
            if let (Some(event), Ok(slot)) = (decode_win_key(message), STATE.lock())
                && let Some(state) = slot.as_ref()
            {
                state.tx.send(event);
            }
        }))
        .ok();
    }
    // SAFETY: always pass the event on; we never consume input.
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if u32::try_from(code) == Ok(HC_ACTION) {
        catch_unwind(AssertUnwindSafe(|| {
            let message = u32::try_from(wparam.0).unwrap_or(0);
            let address = usize::from_ne_bytes(lparam.0.to_ne_bytes());
            let info = ptr::with_exposed_provenance::<MSLLHOOKSTRUCT>(address);
            if info.is_null() {
                return;
            }
            // SAFETY: for WH_MOUSE_LL with HC_ACTION, lParam points at a live MSLLHOOKSTRUCT for this call.
            let point = unsafe { (*info).pt };
            if let Ok(mut slot) = STATE.lock()
                && let Some(state) = slot.as_mut()
                && let Some(event) = state.mouse.decode(message, point.x, point.y)
            {
                state.tx.send(event);
            }
        }))
        .ok();
    }
    // SAFETY: always pass the event on; we never consume input.
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}
