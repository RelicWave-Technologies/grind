//! macOS power and session events.
//!
//! Sources match Electron 33.2.0 / Chromium 130 (see `ELECTRON-PARITY.md`):
//!
//! | event | source |
//! |---|---|
//! | `Suspend` / `Resume` | `IOKit` `IORegisterForSystemPower`: `kIOMessageSystemWillSleep` / `kIOMessageSystemWillPowerOn`, de-duplicated by [`SuspendGate`] — what Chromium's `base::PowerMonitor` does |
//! | `LockScreen` / `UnlockScreen` | distributed notifications `com.apple.screenIsLocked` / `…Unlocked` |
//! | `Shutdown` | `NSWorkspaceWillPowerOffNotification` (shutdown, restart, log out) |
//! | idle "locked" bit | the lock pair above plus `com.apple.screensaver.didstart` / `didstop` |
//!
//! The sink is only ever called on the monitor thread. `IOKit` delivers there
//! directly. The distributed and workspace notifications are delivered by
//! Foundation on the **main** thread — which therefore must be running its run
//! loop (it does in a Tauri/AppKit app; a bare `main` has to pump it, see
//! `examples/probe.rs`). Each one updates the lock flag where it arrives (an
//! atomic) and hands the sink call to the monitor thread with
//! `CFRunLoopPerformBlock`, so the sink never runs anywhere else.

use std::ffi::c_void;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr::{self, NonNull};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::JoinHandle;

use block2::RcBlock;
use objc2::rc::{Retained, autoreleasepool};
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2_app_kit::{NSWorkspace, NSWorkspaceWillPowerOffNotification};
use objc2_foundation::{
    NSDistributedNotificationCenter, NSNotification, NSNotificationCenter, NSObjectProtocol,
    NSString,
};

use super::{PowerEvent, PowerSink, SuspendGate, deliver};
use crate::mac_ffi as ffi;
use crate::{PlatformError, session};

const SLICE_SECONDS: f64 = 0.25;

type Token = Retained<ProtocolObject<dyn NSObjectProtocol>>;

#[derive(Debug)]
pub(super) struct Backend {
    stop: Arc<AtomicBool>,
    /// Shared with the notification handlers that post to the monitor thread; the
    /// run loop is released when the last holder lets go, which is after the join.
    run_loop: Option<Arc<ffi::OwnedRunLoop>>,
    thread: Option<JoinHandle<()>>,
}

struct PowerCtx {
    sink: Arc<dyn PowerSink>,
    gate: Mutex<SuspendGate>,
    /// `io_connect_t` from `IORegisterForSystemPower`, needed to acknowledge power changes.
    connect: AtomicU32,
}

/// Everything registered with the OS, so teardown is symmetric.
struct Registration {
    ctx: *mut PowerCtx,
    port: *mut c_void,
    notifier: u32,
    centers: Vec<(Retained<NSNotificationCenter>, Token)>,
}

impl Backend {
    pub(super) fn start(sink: Arc<dyn PowerSink>) -> Result<Self, PlatformError> {
        let stop = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = mpsc::channel();
        let thread_stop = Arc::clone(&stop);
        let thread = std::thread::Builder::new()
            .name("timo-power-events".to_owned())
            .spawn(move || run(&sink, &thread_stop, &ready_tx))
            .map_err(|e| PlatformError::os("spawn power monitor thread", e))?;
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
                    "power monitor thread",
                    "exited before it was ready",
                ))
            }
        }
    }

    /// Idempotent. Flag, stop the loop (our retained reference keeps the pointer valid
    /// even if the worker already exited), join, then let the reference go.
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
    sink: &Arc<dyn PowerSink>,
    stop: &AtomicBool,
    ready: &mpsc::Sender<Result<Arc<ffi::OwnedRunLoop>, PlatformError>>,
) {
    autoreleasepool(|_| {
        let Some(run_loop) = ffi::OwnedRunLoop::retain_current().map(Arc::new) else {
            ready
                .send(Err(PlatformError::os(
                    "CFRunLoopGetCurrent",
                    "returned null",
                )))
                .ok();
            return;
        };
        let registration = match register(sink, &run_loop) {
            Ok(registration) => registration,
            Err(error) => {
                ready.send(Err(error)).ok();
                return;
            }
        };
        ready.send(Ok(run_loop)).ok();
        while !stop.load(Ordering::SeqCst) {
            // SAFETY: running this thread's loop in the default mode for a short slice.
            let outcome = unsafe {
                ffi::CFRunLoopRunInMode(ffi::kCFRunLoopDefaultMode, SLICE_SECONDS, false)
            };
            if outcome == ffi::K_CF_RUN_LOOP_RUN_FINISHED {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
        // Flush blocks already queued for this thread so a lock event that beat `stop` is delivered.
        // SAFETY: a zero-length slice of this thread's loop in the default mode.
        unsafe { ffi::CFRunLoopRunInMode(ffi::kCFRunLoopDefaultMode, 0.0, false) };
        // SAFETY: the loop has exited; `registration` came from `register` and is torn down once.
        unsafe { unregister(&registration) };
    });
}

fn register(
    sink: &Arc<dyn PowerSink>,
    run_loop: &Arc<ffi::OwnedRunLoop>,
) -> Result<Registration, PlatformError> {
    let ctx = Box::into_raw(Box::new(PowerCtx {
        sink: Arc::clone(sink),
        gate: Mutex::new(SuspendGate::default()),
        connect: AtomicU32::new(0),
    }));
    let mut port: *mut c_void = ptr::null_mut();
    let mut notifier: u32 = 0;
    // SAFETY: `ctx` is a leaked Box that outlives the registration; the out-pointers are valid locals.
    let connect = unsafe {
        ffi::IORegisterForSystemPower(ctx.cast(), &raw mut port, power_callback, &raw mut notifier)
    };
    if connect == 0 || port.is_null() {
        // SAFETY: registration failed, so nothing else holds `ctx`.
        drop(unsafe { Box::from_raw(ctx) });
        return Err(PlatformError::os(
            "IORegisterForSystemPower",
            "returned no connection",
        ));
    }
    // SAFETY: `ctx` is live; the connection is stored before the loop can deliver a message.
    unsafe { (*ctx).connect.store(connect, Ordering::SeqCst) };
    // SAFETY: `port` is the notification port just created; its source is added to this thread's loop.
    unsafe {
        let source = ffi::IONotificationPortGetRunLoopSource(port);
        ffi::CFRunLoopAddSource(
            ffi::CFRunLoopGetCurrent(),
            source,
            ffi::kCFRunLoopCommonModes,
        );
    }
    Ok(Registration {
        ctx,
        port,
        notifier,
        centers: observe_notifications(sink, run_loop),
    })
}

type Handler = Box<dyn Fn()>;

/// A handler that updates a session flag where the notification arrives (an atomic,
/// so the idle state is current at once) and hands the sink call to the monitor
/// thread. It runs on whatever thread Foundation delivers on — the main thread.
fn session_handler(
    sink: &Arc<dyn PowerSink>,
    run_loop: &Arc<ffi::OwnedRunLoop>,
    update: fn(),
    event: Option<PowerEvent>,
) -> Handler {
    let sink = Arc::clone(sink);
    let run_loop = Arc::clone(run_loop);
    Box::new(move || {
        update();
        if let Some(event) = event {
            let sink = Arc::clone(&sink);
            let block = RcBlock::new(move || deliver(&*sink, event));
            run_loop.perform(&block);
        }
    })
}

/// Subscribe to the lock/unlock/screensaver and power-off notifications.
fn observe_notifications(
    sink: &Arc<dyn PowerSink>,
    run_loop: &Arc<ffi::OwnedRunLoop>,
) -> Vec<(Retained<NSNotificationCenter>, Token)> {
    let distributed: Retained<NSNotificationCenter> =
        NSDistributedNotificationCenter::defaultCenter().into_super();
    let workspace = NSWorkspace::sharedWorkspace().notificationCenter();
    let on_distributed: [(&str, Handler); 4] = [
        (
            "com.apple.screenIsLocked",
            session_handler(
                sink,
                run_loop,
                || session::set_locked(true),
                Some(PowerEvent::LockScreen),
            ),
        ),
        (
            "com.apple.screenIsUnlocked",
            session_handler(
                sink,
                run_loop,
                || session::set_locked(false),
                Some(PowerEvent::UnlockScreen),
            ),
        ),
        (
            "com.apple.screensaver.didstart",
            session_handler(sink, run_loop, || session::set_screensaver(true), None),
        ),
        (
            "com.apple.screensaver.didstop",
            session_handler(sink, run_loop, || session::set_screensaver(false), None),
        ),
    ];
    let mut centers: Vec<_> = on_distributed
        .into_iter()
        .map(|(name, handler)| {
            let token = add_observer(&distributed, &NSString::from_str(name), handler);
            (distributed.clone(), token)
        })
        .collect();
    // SAFETY: reading an immutable AppKit string constant.
    let power_off = unsafe { NSWorkspaceWillPowerOffNotification };
    let shutdown = session_handler(sink, run_loop, || {}, Some(PowerEvent::Shutdown));
    centers.push((
        workspace.clone(),
        add_observer(&workspace, power_off, shutdown),
    ));
    centers
}

fn add_observer(center: &NSNotificationCenter, name: &NSString, handler: Handler) -> Token {
    let block = RcBlock::new(move |_: NonNull<NSNotification>| handler());
    // SAFETY: nil object and queue are allowed (the block then runs on the delivering thread, the main one; the handlers hop to the monitor thread); the block is 'static.
    unsafe { center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block) }
}

/// # Safety
/// `registration` must come from `register` and not be used again.
unsafe fn unregister(registration: &Registration) {
    for (center, token) in &registration.centers {
        // SAFETY: `token` is the observer returned by this very center.
        unsafe { center.removeObserver(AsRef::<AnyObject>::as_ref(&**token)) };
    }
    // SAFETY: tear the IOKit registration down in the reverse of `register`.
    unsafe {
        let mut notifier = registration.notifier;
        let source = ffi::IONotificationPortGetRunLoopSource(registration.port);
        ffi::CFRunLoopRemoveSource(
            ffi::CFRunLoopGetCurrent(),
            source,
            ffi::kCFRunLoopCommonModes,
        );
        ffi::IODeregisterForSystemPower(&raw mut notifier);
        ffi::IOServiceClose((*registration.ctx).connect.load(Ordering::SeqCst));
        ffi::IONotificationPortDestroy(registration.port);
        drop(Box::from_raw(registration.ctx));
    }
}

unsafe extern "C" fn power_callback(
    refcon: *mut c_void,
    _service: u32,
    message_type: u32,
    message_argument: *mut c_void,
) {
    // SAFETY: `refcon` is the PowerCtx registered in `register`, alive until `unregister`.
    let ctx = unsafe { &*refcon.cast::<PowerCtx>() };
    // A panic must never unwind into IOKit, and the system must always be allowed to proceed.
    let outcome = catch_unwind(AssertUnwindSafe(|| on_message(ctx, message_type)));
    if outcome.is_err() {
        tracing::error!("panic in the power callback was contained");
    }
    if matches!(
        message_type,
        ffi::K_IO_MESSAGE_CAN_SYSTEM_SLEEP | ffi::K_IO_MESSAGE_SYSTEM_WILL_SLEEP
    ) {
        let [b0, b1, b2, b3, b4, b5, b6, b7] = message_argument.addr().to_ne_bytes();
        let id = isize::from_ne_bytes([b0, b1, b2, b3, b4, b5, b6, b7]);
        // SAFETY: acknowledges a sleep notification with the id IOKit passed us on this connection.
        unsafe { ffi::IOAllowPowerChange(ctx.connect.load(Ordering::SeqCst), id) };
    }
}

fn on_message(ctx: &PowerCtx, message_type: u32) {
    let emit = match message_type {
        ffi::K_IO_MESSAGE_SYSTEM_WILL_SLEEP => ctx
            .gate
            .lock()
            .is_ok_and(|mut gate| gate.on_suspend())
            .then_some(PowerEvent::Suspend),
        ffi::K_IO_MESSAGE_SYSTEM_WILL_POWER_ON => ctx
            .gate
            .lock()
            .is_ok_and(|mut gate| gate.on_resume())
            .then_some(PowerEvent::Resume),
        _ => None,
    };
    if let Some(event) = emit {
        deliver(&*ctx.sink, event);
    }
}
