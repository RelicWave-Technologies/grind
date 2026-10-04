//! macOS input counting: an *active* `CGEventTap` on its own `CFRunLoop` thread —
//! exactly what `uiohook-napi` creates, so the permission story is the oracle's.
//!
//! Mirrors libuiohook `darwin/input_hook.c`: `kCGSessionEventTap`,
//! `kCGHeadInsertEventTap`, `kCGEventTapOptionDefault` (active, not listen-only),
//! the same event mask (`decide::mac_event_mask`), and `hook_run`'s gate on
//! Accessibility (`is_accessibility_enabled`) before the tap is created. Legacy
//! gates on the same grant (`hasAccessibilityAccess(false)`). A non-null tap is
//! never taken as proof of permission: `Granted` is reported only after that gate.
//!
//! An active tap must answer promptly or macOS disables it, so the callback does
//! no work beyond decoding one event and queueing it, and always returns the event
//! unmodified. The loop re-arms the tap if macOS switches it off.

use std::ffi::c_void;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};
use std::sync::mpsc;
use std::thread::JoinHandle;

use super::decide;
use super::mac_read::read_raw;
use super::{EventTx, InputPermission, Shared};
use crate::mac_ffi as ffi;
use crate::{PermissionKind, PlatformError};

/// How long one run-loop slice lasts before the stop flag and tap health are checked.
const SLICE_SECONDS: f64 = 0.25;

#[derive(Debug)]
pub(super) struct Backend {
    stop: Arc<AtomicBool>,
    /// Owned (+1) reference; released only after the worker thread has been joined.
    run_loop: Option<ffi::OwnedRunLoop>,
    thread: Option<JoinHandle<()>>,
}

struct TapContext {
    tx: EventTx,
    tap: AtomicPtr<c_void>,
}

impl Backend {
    pub(super) fn start(tx: EventTx, shared: Arc<Shared>) -> Result<Self, PlatformError> {
        let stop = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = mpsc::channel();
        let thread_stop = Arc::clone(&stop);
        let thread = std::thread::Builder::new()
            .name("timo-input-tap".to_owned())
            .spawn(move || run(tx, &shared, &thread_stop, &ready_tx))
            .map_err(|e| PlatformError::os("spawn event tap thread", e))?;
        match ready_rx.recv() {
            Ok(Ok(run_loop)) => Ok(Self {
                stop,
                run_loop: Some(run_loop),
                thread: Some(thread),
            }),
            Ok(Err(error)) => {
                thread.join().ok();
                Err(error)
            }
            Err(_) => {
                thread.join().ok();
                Err(PlatformError::os(
                    "event tap thread",
                    "exited before it was ready",
                ))
            }
        }
    }

    /// Idempotent. Order matters: flag, stop the loop (our retained reference keeps the
    /// pointer valid even if the worker has already exited), join, and only then release.
    pub(super) fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(run_loop) = &self.run_loop {
            run_loop.stop();
        }
        if let Some(thread) = self.thread.take() {
            thread.join().ok();
        }
        self.run_loop = None;
    }
}

impl Drop for Backend {
    fn drop(&mut self) {
        self.stop();
    }
}

fn run(
    tx: EventTx,
    shared: &Shared,
    stop: &AtomicBool,
    ready: &mpsc::Sender<Result<ffi::OwnedRunLoop, PlatformError>>,
) {
    if let Some(error) = accessibility_gate(shared) {
        ready.send(Err(error)).ok();
        return;
    }
    let context = Box::into_raw(Box::new(TapContext {
        tx,
        tap: AtomicPtr::new(ptr::null_mut()),
    }));
    // SAFETY: `context` is a valid leaked Box; it is reclaimed at the end of this function, after the tap is invalidated.
    let tap = unsafe { create_tap(context) };
    if tap.is_null() {
        let error = tap_creation_error(shared);
        // SAFETY: the tap was never created, so no callback can hold `context`.
        drop(unsafe { Box::from_raw(context) });
        ready.send(Err(error)).ok();
        return;
    }
    // SAFETY: `context` is live; the tap pointer is published before the callback can need it to re-arm.
    unsafe { (*context).tap.store(tap, Ordering::SeqCst) };
    // SAFETY: `tap` is a valid CFMachPort; a null allocator means the default.
    let source = unsafe { ffi::CFMachPortCreateRunLoopSource(ptr::null(), tap, 0) };
    if source.is_null() {
        // SAFETY: tear down exactly what was created above.
        unsafe { destroy(tap, ptr::null_mut(), context) };
        ready
            .send(Err(PlatformError::os(
                "CFMachPortCreateRunLoopSource",
                "returned null",
            )))
            .ok();
        return;
    }
    let Some(owned) = ffi::OwnedRunLoop::retain_current() else {
        // SAFETY: tear down exactly what was created above.
        unsafe { destroy(tap, source, context) };
        ready
            .send(Err(PlatformError::os(
                "CFRunLoopGetCurrent",
                "returned null",
            )))
            .ok();
        return;
    };
    arm(tap, source, shared);
    ready.send(Ok(owned)).ok();

    service_loop(tap, shared, stop);
    shared.set_error(None);
    // SAFETY: loop has exited; tear down in reverse creation order.
    unsafe { destroy(tap, source, context) };
}

/// Attach the tap to this thread's loop and switch it on. Only after the Accessibility
/// gate and a successful create is permission reported as granted.
fn arm(tap: ffi::CFMachPortRef, source: ffi::CFRunLoopSourceRef, shared: &Shared) {
    // SAFETY: `source` and `tap` are valid; adding the source to this thread's loop is the documented use.
    unsafe {
        ffi::CFRunLoopAddSource(
            ffi::CFRunLoopGetCurrent(),
            source,
            ffi::kCFRunLoopCommonModes,
        );
        ffi::CGEventTapEnable(tap, true);
    }
    shared.set_permission(InputPermission::Granted);
    shared.set_error(None);
}

/// Run this thread's loop in short slices until asked to stop, watching the tap.
fn service_loop(tap: ffi::CFMachPortRef, shared: &Shared, stop: &AtomicBool) {
    while !stop.load(Ordering::SeqCst) {
        // SAFETY: running the current thread's loop in the default mode for a short slice.
        let outcome =
            unsafe { ffi::CFRunLoopRunInMode(ffi::kCFRunLoopDefaultMode, SLICE_SECONDS, false) };
        if outcome == ffi::K_CF_RUN_LOOP_RUN_FINISHED {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        check_tap_health(tap, shared);
    }
}

/// `hook_run`'s `is_accessibility_enabled()` gate, without the prompt (legacy checks
/// `hasAccessibilityAccess(false)` first, so libuiohook's own prompt never fires).
fn accessibility_gate(shared: &Shared) -> Option<PlatformError> {
    if crate::permissions::accessibility_trusted(false).unwrap_or(false) {
        return None;
    }
    shared.set_permission(InputPermission::Denied);
    shared.set_error(Some("Accessibility permission is not granted".to_owned()));
    Some(PlatformError::PermissionDenied(
        PermissionKind::Accessibility,
    ))
}

/// Create the active tap for the counted event types, as libuiohook does.
///
/// # Safety
/// `context` must stay valid for as long as the tap exists.
unsafe fn create_tap(context: *mut TapContext) -> ffi::CFMachPortRef {
    // SAFETY: arguments are valid constants; `context` outlives the tap per this function's contract.
    unsafe {
        ffi::CGEventTapCreate(
            ffi::K_CG_SESSION_EVENT_TAP,
            ffi::K_CG_HEAD_INSERT_EVENT_TAP,
            ffi::K_CG_EVENT_TAP_OPTION_DEFAULT,
            decide::mac_event_mask(),
            tap_callback,
            context.cast(),
        )
    }
}

/// `CGEventTapCreate` returned null although Accessibility is trusted (libuiohook's
/// `UIOHOOK_ERROR_CREATE_EVENT_PORT`). Legacy's note: a machine that additionally
/// demands Input Monitoring shows up exactly like this, so the preflight tells the
/// two apart for the message. Permission stays not-granted either way.
fn tap_creation_error(shared: &Shared) -> PlatformError {
    shared.set_permission(InputPermission::Denied);
    // SAFETY: no arguments, no preconditions.
    if unsafe { ffi::CGPreflightListenEventAccess() } {
        shared.set_error(Some("CGEventTapCreate returned null".to_owned()));
        PlatformError::os(
            "CGEventTapCreate",
            "returned null although Accessibility is granted",
        )
    } else {
        shared.set_error(Some(
            "event tap refused: Input Monitoring is also required on this Mac".to_owned(),
        ));
        PlatformError::PermissionDenied(PermissionKind::InputMonitoring)
    }
}

/// Tear down the tap, its run-loop source and the callback context.
///
/// # Safety
/// `tap` and `context` must come from `run`; `source` may be null. Nothing may use them afterwards.
unsafe fn destroy(
    tap: ffi::CFMachPortRef,
    source: ffi::CFRunLoopSourceRef,
    context: *mut TapContext,
) {
    // SAFETY: per the contract above; the tap is invalidated before the context it points at is freed.
    unsafe {
        ffi::CGEventTapEnable(tap, false);
        if !source.is_null() {
            ffi::CFRunLoopRemoveSource(
                ffi::CFRunLoopGetCurrent(),
                source,
                ffi::kCFRunLoopCommonModes,
            );
            ffi::CFRelease(source);
        }
        ffi::CFMachPortInvalidate(tap);
        ffi::CFRelease(tap);
        drop(Box::from_raw(context));
    }
}

/// Re-arm a tap macOS has switched off; if it stays off, say why.
fn check_tap_health(tap: ffi::CFMachPortRef, shared: &Shared) {
    // SAFETY: `tap` is valid until `destroy`, which runs after the last call here.
    unsafe {
        if ffi::CGEventTapIsEnabled(tap) {
            return;
        }
        ffi::CGEventTapEnable(tap, true);
        if ffi::CGEventTapIsEnabled(tap) {
            tracing::info!("input tap was disabled by macOS and has been re-enabled");
            return;
        }
        let granted = crate::permissions::accessibility_trusted(false).unwrap_or(false);
        shared.set_permission(if granted {
            InputPermission::Granted
        } else {
            InputPermission::Denied
        });
        shared.set_error(Some(if granted {
            "event tap is disabled and could not be re-enabled".to_owned()
        } else {
            "Accessibility permission was revoked".to_owned()
        }));
    }
}

unsafe extern "C" fn tap_callback(
    _proxy: ffi::CGEventTapProxy,
    event_type: u32,
    event: ffi::CGEventRef,
    user_info: *mut c_void,
) -> ffi::CGEventRef {
    // A panic must never unwind into CoreGraphics.
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: `user_info` is the TapContext created in `run`, alive until the tap is invalidated.
        unsafe { handle(event_type, event, user_info) };
    }));
    if outcome.is_err() {
        tracing::error!("panic in the input tap callback was contained");
    }
    event
}

/// # Safety
/// `user_info` must point at a live `TapContext`; `event` is a live `CGEvent` or null.
unsafe fn handle(event_type: u32, event: ffi::CGEventRef, user_info: *mut c_void) {
    // SAFETY: per the contract above.
    let context = unsafe { &*user_info.cast::<TapContext>() };
    if decide::tap_was_disabled(event_type) {
        let tap = context.tap.load(Ordering::SeqCst);
        if !tap.is_null() {
            // SAFETY: the tap pointer was published by `run` and stays valid until teardown.
            unsafe { ffi::CGEventTapEnable(tap, true) };
        }
        return;
    }
    if event.is_null() {
        return;
    }
    // SAFETY: `event` is non-null and live for the duration of the callback.
    let raw = unsafe { read_raw(event_type, event) };
    if let Some(decoded) = decide::decode_mac(&raw) {
        context.tx.send(decoded);
    }
}
