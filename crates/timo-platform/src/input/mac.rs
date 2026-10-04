//! macOS input counting: a listen-only `CGEventTap` on its own `CFRunLoop` thread.
//!
//! Differences from `uiohook-napi` (which creates an *active* tap, which is why
//! legacy gates on Accessibility): this tap is listen-only, so it needs Input
//! Monitoring, not Accessibility. The events counted are identical — see
//! `decide.rs`. The tap callback does no work beyond decoding one event and
//! queueing it; the loop re-arms the tap if macOS switches it off.

use std::ffi::c_void;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};
use std::sync::mpsc;
use std::thread::JoinHandle;

use objc2::encode::{Encoding, RefEncode};
use objc2::msg_send;
use objc2::rc::{Retained, autoreleasepool};
use objc2::runtime::{AnyClass, AnyObject};

use super::decide::{self, MacRaw, cg};
use super::{EventTx, InputPermission, Shared};
use crate::mac_ffi as ffi;
use crate::{PermissionKind, PlatformError};

/// How long one run-loop slice lasts before the stop flag and tap health are checked.
const SLICE_SECONDS: f64 = 0.25;

#[derive(Debug)]
pub(super) struct Backend {
    stop: Arc<AtomicBool>,
    run_loop: RunLoop,
    thread: Option<JoinHandle<()>>,
}

/// A `CFRunLoopRef` that may be handed to another thread: `CFRunLoopStop` is
/// documented thread-safe.
#[derive(Clone, Copy, Debug)]
struct RunLoop(ffi::CFRunLoopRef);

// SAFETY: only `CFRunLoopStop` is called through it from other threads, which Apple documents as thread-safe.
unsafe impl Send for RunLoop {}

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
                run_loop,
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

    pub(super) fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // SAFETY: the run loop belongs to a thread we still own (not yet joined); `CFRunLoopStop` is thread-safe.
        unsafe { ffi::CFRunLoopStop(self.run_loop.0) };
        if let Some(thread) = self.thread.take() {
            thread.join().ok();
        }
    }
}

fn run(
    tx: EventTx,
    shared: &Shared,
    stop: &AtomicBool,
    ready: &mpsc::Sender<Result<RunLoop, PlatformError>>,
) {
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
    // SAFETY: the current run loop and common-modes constant are valid for this thread's lifetime.
    let run_loop = unsafe { ffi::CFRunLoopGetCurrent() };
    // SAFETY: `source` and `tap` are valid; adding the source to this thread's loop is the documented use.
    unsafe {
        ffi::CFRunLoopAddSource(run_loop, source, ffi::kCFRunLoopCommonModes);
        ffi::CGEventTapEnable(tap, true);
    }
    shared.set_permission(InputPermission::Granted);
    shared.set_error(None);
    ready.send(Ok(RunLoop(run_loop))).ok();

    while !stop.load(Ordering::SeqCst) {
        // SAFETY: running the current thread's loop in the default mode for a short slice.
        let outcome =
            unsafe { ffi::CFRunLoopRunInMode(ffi::kCFRunLoopDefaultMode, SLICE_SECONDS, false) };
        if outcome == ffi::K_CF_RUN_LOOP_RUN_FINISHED {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        check_tap_health(tap, shared);
    }
    shared.set_error(None);
    // SAFETY: loop has exited; tear down in reverse creation order.
    unsafe { destroy(tap, source, context) };
}

/// Create the listen-only tap for the counted event types.
///
/// # Safety
/// `context` must stay valid for as long as the tap exists.
unsafe fn create_tap(context: *mut TapContext) -> ffi::CFMachPortRef {
    // SAFETY: arguments are valid constants; `context` outlives the tap per this function's contract.
    unsafe {
        ffi::CGEventTapCreate(
            ffi::K_CG_SESSION_EVENT_TAP,
            ffi::K_CG_HEAD_INSERT_EVENT_TAP,
            ffi::K_CG_EVENT_TAP_OPTION_LISTEN_ONLY,
            decide::mac_event_mask(),
            tap_callback,
            context.cast(),
        )
    }
}

/// `CGEventTapCreate` returns null without Input Monitoring; the preflight call
/// tells that apart from other failures.
fn tap_creation_error(shared: &Shared) -> PlatformError {
    // SAFETY: no arguments, no preconditions.
    let granted = unsafe { ffi::CGPreflightListenEventAccess() };
    if granted {
        shared.set_error(Some("CGEventTapCreate returned null".to_owned()));
        PlatformError::os(
            "CGEventTapCreate",
            "returned null although Input Monitoring is granted",
        )
    } else {
        shared.set_permission(InputPermission::Denied);
        shared.set_error(Some(
            "Input Monitoring permission is not granted".to_owned(),
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
        let granted = ffi::CGPreflightListenEventAccess();
        shared.set_permission(if granted {
            InputPermission::Granted
        } else {
            InputPermission::Denied
        });
        shared.set_error(Some(if granted {
            "event tap is disabled and could not be re-enabled".to_owned()
        } else {
            "Input Monitoring permission was revoked".to_owned()
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

/// Read only the fields the decision for this event type needs. Key codes are
/// read for modifier changes alone; ordinary key presses are never inspected.
///
/// # Safety
/// `event` must be a live `CGEvent`.
unsafe fn read_raw(kind: u32, event: ffi::CGEventRef) -> MacRaw {
    let mut raw = MacRaw {
        kind,
        ..MacRaw::default()
    };
    // SAFETY: `event` is live per this function's contract.
    unsafe {
        match kind {
            cg::FLAGS_CHANGED => {
                raw.keycode =
                    ffi::CGEventGetIntegerValueField(event, ffi::K_CG_KEYBOARD_EVENT_KEYCODE);
                raw.flags = ffi::CGEventGetFlags(event);
            }
            cg::MOUSE_MOVED
            | cg::LEFT_MOUSE_DRAGGED
            | cg::RIGHT_MOUSE_DRAGGED
            | cg::OTHER_MOUSE_DRAGGED => {
                let point = ffi::CGEventGetLocation(event);
                raw.x = point.x;
                raw.y = point.y;
            }
            cg::SCROLL_WHEEL => {
                raw.scroll_axis_1 = ffi::CGEventGetIntegerValueField(
                    event,
                    ffi::K_CG_SCROLL_WHEEL_EVENT_DELTA_AXIS_1,
                );
                raw.scroll_axis_2 = ffi::CGEventGetIntegerValueField(
                    event,
                    ffi::K_CG_SCROLL_WHEEL_EVENT_DELTA_AXIS_2,
                );
            }
            cg::SYS_DEFINED => raw.system_defined = system_defined_fields(event),
            _ => {}
        }
    }
    raw
}

/// An opaque `CGEventRef` target with the encoding `NSEvent +eventWithCGEvent:` expects.
#[repr(C)]
struct OpaqueCgEvent {
    _private: [u8; 0],
}

// SAFETY: matches the Objective-C type encoding `^{__CGEvent=}` of a `CGEventRef`.
unsafe impl RefEncode for OpaqueCgEvent {
    const ENCODING_REF: Encoding = Encoding::Pointer(&Encoding::Struct("__CGEvent", &[]));
}

/// `(NSEvent.subtype, NSEvent.data1)` for an `NX_SYSDEFINED` event — how
/// libuiohook (built with `USE_OBJC`, as `uiohook-napi` is) reads media keys.
///
/// # Safety
/// `event` must be a live `CGEvent`.
unsafe fn system_defined_fields(event: ffi::CGEventRef) -> Option<(i64, i64)> {
    autoreleasepool(|_| {
        let class = AnyClass::get(c"NSEvent")?;
        // SAFETY: `+eventWithCGEvent:` takes a CGEventRef and returns an autoreleased NSEvent or nil.
        let ns_event: Option<Retained<AnyObject>> =
            unsafe { msg_send![class, eventWithCGEvent: event.cast::<OpaqueCgEvent>()] };
        let ns_event = ns_event?;
        // SAFETY: `-subtype` returns a short and `-data1` an NSInteger on any NSEvent.
        let (subtype, data1): (i16, isize) =
            unsafe { (msg_send![&*ns_event, subtype], msg_send![&*ns_event, data1]) };
        Some((i64::from(subtype), i64::try_from(data1).ok()?))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2_foundation::NSPoint;

    /// Build a real `NSEvent` of type system-defined, take its `CGEvent`, and read
    /// the fields back through the same code the tap uses — on a non-main thread,
    /// as the tap does.
    fn read_back(subtype: i16, data1: isize) -> Option<(i64, i64)> {
        std::thread::spawn(move || {
            autoreleasepool(|_| {
                let class = AnyClass::get(c"NSEvent")?;
                // SAFETY: documented factory method; arguments match its Objective-C signature.
                let ns_event: Option<Retained<AnyObject>> = unsafe {
                    msg_send![
                        class,
                        otherEventWithType: 14usize,
                        location: NSPoint::new(0.0, 0.0),
                        modifierFlags: 0usize,
                        timestamp: 0.0f64,
                        windowNumber: 0isize,
                        context: std::ptr::null::<AnyObject>(),
                        subtype: subtype,
                        data1: data1,
                        data2: 0isize
                    ]
                };
                let ns_event = ns_event?;
                // SAFETY: `-CGEvent` returns the event's CGEventRef, valid while `ns_event` lives.
                let cg: *mut OpaqueCgEvent = unsafe { msg_send![&*ns_event, CGEvent] };
                if cg.is_null() {
                    return None;
                }
                // SAFETY: `cg` is a live CGEvent for the duration of this call.
                unsafe { system_defined_fields(cg.cast()) }
            })
        })
        .join()
        .ok()
        .flatten()
    }

    #[test]
    fn media_key_fields_survive_the_cg_event_round_trip() {
        let data1 = (19isize << 16) | (0x0A << 8); // fast-forward, key down
        assert_eq!(
            read_back(8, data1),
            Some((8, i64::try_from(data1).unwrap()))
        );
    }

    #[test]
    fn round_tripped_fields_drive_the_decision() {
        let down = read_back(8, (7isize << 16) | (0x0A << 8)).expect("fields");
        assert!(
            decide::system_defined_is_press(down.0, down.1),
            "mute down counts"
        );
        let up = read_back(8, (7isize << 16) | (0x0B << 8)).expect("fields");
        assert!(
            !decide::system_defined_is_press(up.0, up.1),
            "mute up does not"
        );
    }
}
