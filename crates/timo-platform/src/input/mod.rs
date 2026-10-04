//! Global input *counting*: keystrokes, clicks, pointer movement, scroll.
//!
//! Equivalent of `uiohook-napi` as `legacy/agent` uses it. A listener delivers
//! [`InputEvent`]s to a `Send + Sync` sink. Events carry no key identity and no
//! text — only "a key went down" — plus the pointer position for moves.
//!
//! # Threading
//!
//! * **OS thread** (macOS: a `CFRunLoop` thread; Windows: a `GetMessageW` pump)
//!   decodes each OS event and pushes it into a bounded queue. Nothing slow runs
//!   there: a macOS event tap that stalls is disabled by the system, and a Windows
//!   low-level hook that takes more than `LowLevelHooksTimeout` is silently removed.
//! * **Dispatcher thread** pops the queue and calls your sink, so a slow sink
//!   costs queue depth, not the hook. If the queue overflows (4096 events) the
//!   newest events are dropped and counted in [`InputStatus::dropped_events`].
//! * [`InputListener::stop`] stops the OS thread, then lets the dispatcher drain
//!   what is queued, so every event seen before `stop` returns reaches the sink.
//!
//! Only one listener may run per process.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use crate::PlatformError;

pub(crate) mod decide;
pub use decide::MoveThrottle;

#[cfg(target_os = "macos")]
mod mac;
#[cfg(target_os = "macos")]
use mac as imp;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
use windows as imp;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod unsupported;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
use unsupported as imp;

const QUEUE_DEPTH: usize = 4096;

/// What legacy counts. Mirrors the four `uIOhook` events it subscribes to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputEvent {
    /// `keydown` — any key, including auto-repeat; the key itself is not reported.
    KeyDown,
    /// `mousedown` — any button.
    MouseDown,
    /// `mousemove` — also covers drags. Coordinates are libuiohook's `int16`
    /// screen position (points on macOS, pixels on Windows).
    MouseMove { x: i16, y: i16 },
    /// `wheel` — one per OS scroll event, either axis.
    Wheel,
}

/// Receives events. Implemented for `Fn(InputEvent)` closures.
pub trait InputSink: Send + Sync + 'static {
    fn on_input(&self, event: InputEvent);
}

impl<F> InputSink for F
where
    F: Fn(InputEvent) + Send + Sync + 'static,
{
    fn on_input(&self, event: InputEvent) {
        self(event);
    }
}

/// Whether the OS lets us see input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputPermission {
    /// The event tap was created / the hook installed.
    Granted,
    /// macOS refused (Input Monitoring missing or revoked).
    Denied,
    /// Windows needs no grant.
    NotRequired,
    /// Not tried yet.
    Unknown,
}

impl InputPermission {
    fn to_u8(self) -> u8 {
        match self {
            Self::Unknown => 0,
            Self::Granted => 1,
            Self::Denied => 2,
            Self::NotRequired => 3,
        }
    }

    fn from_u8(value: u8) -> Self {
        match value {
            1 => Self::Granted,
            2 => Self::Denied,
            3 => Self::NotRequired,
            _ => Self::Unknown,
        }
    }
}

/// Snapshot of a listener. `running` ↔ legacy `hookRunning`, `last_error` ↔
/// `lastHookError`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InputStatus {
    pub running: bool,
    pub last_error: Option<String>,
    pub permission: InputPermission,
    pub dropped_events: u64,
}

/// State shared between the OS thread, the dispatcher and the handle.
#[derive(Debug)]
pub(crate) struct Shared {
    running: AtomicBool,
    dropped: AtomicU64,
    permission: AtomicU8,
    last_error: Mutex<Option<String>>,
}

impl Shared {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            running: AtomicBool::new(false),
            dropped: AtomicU64::new(0),
            permission: AtomicU8::new(InputPermission::Unknown.to_u8()),
            last_error: Mutex::new(None),
        })
    }

    pub(crate) fn set_running(&self, running: bool) {
        self.running.store(running, Ordering::SeqCst);
    }

    pub(crate) fn set_permission(&self, permission: InputPermission) {
        self.permission.store(permission.to_u8(), Ordering::SeqCst);
    }

    pub(crate) fn set_error(&self, error: Option<String>) {
        if let Ok(mut slot) = self.last_error.lock() {
            *slot = error;
        }
    }

    fn snapshot(&self) -> InputStatus {
        InputStatus {
            running: self.running.load(Ordering::SeqCst),
            last_error: self.last_error.lock().ok().and_then(|slot| slot.clone()),
            permission: InputPermission::from_u8(self.permission.load(Ordering::SeqCst)),
            dropped_events: self.dropped.load(Ordering::SeqCst),
        }
    }
}

/// Handed to the OS thread: a non-blocking way to queue an event.
#[derive(Clone, Debug)]
pub(crate) struct EventTx {
    tx: SyncSender<InputEvent>,
    shared: Arc<Shared>,
}

impl EventTx {
    pub(crate) fn send(&self, event: InputEvent) {
        if self.tx.try_send(event).is_err() {
            self.shared.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
}

/// Only one listener per process (Windows hook callbacks have no user-data slot).
static ACTIVE: AtomicBool = AtomicBool::new(false);

/// A running input listener. Dropping it stops it.
#[derive(Debug)]
pub struct InputListener {
    shared: Arc<Shared>,
    backend: Option<imp::Backend>,
    tx: Option<EventTx>,
    dispatcher: Option<JoinHandle<()>>,
}

impl InputListener {
    /// Start counting. Returns once the OS hook is installed (or has failed):
    /// a missing macOS permission is reported here as
    /// [`PlatformError::PermissionDenied`], like `uIOhook.start()` throwing.
    pub fn start(sink: Arc<dyn InputSink>) -> Result<Self, PlatformError> {
        if ACTIVE
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(PlatformError::AlreadyRunning("input listener"));
        }
        let shared = Shared::new();
        let (tx, rx) = mpsc::sync_channel(QUEUE_DEPTH);
        let event_tx = EventTx {
            tx,
            shared: Arc::clone(&shared),
        };
        let dispatcher = spawn_dispatcher(rx, sink, Arc::clone(&shared));
        match imp::Backend::start(event_tx.clone(), Arc::clone(&shared)) {
            Ok(backend) => {
                shared.set_running(true);
                Ok(Self {
                    shared,
                    backend: Some(backend),
                    tx: Some(event_tx),
                    dispatcher: Some(dispatcher),
                })
            }
            Err(error) => {
                drop(event_tx);
                // The failed backend dropped its sender copy; ours is gone too, so
                // the dispatcher sees the channel close and exits.
                dispatcher.join().ok();
                ACTIVE.store(false, Ordering::SeqCst);
                Err(error)
            }
        }
    }

    /// Current status.
    #[must_use]
    pub fn status(&self) -> InputStatus {
        self.shared.snapshot()
    }

    /// Stop the OS hook, deliver everything already queued, and join the threads.
    pub fn stop(&mut self) {
        if let Some(mut backend) = self.backend.take() {
            backend.stop();
        }
        self.shared.set_running(false);
        self.tx = None;
        if let Some(handle) = self.dispatcher.take() {
            handle.join().ok();
        }
        ACTIVE.store(false, Ordering::SeqCst);
    }
}

impl Drop for InputListener {
    fn drop(&mut self) {
        self.stop();
    }
}

fn spawn_dispatcher(
    rx: mpsc::Receiver<InputEvent>,
    sink: Arc<dyn InputSink>,
    shared: Arc<Shared>,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        for event in rx {
            if catch_unwind(AssertUnwindSafe(|| sink.on_input(event))).is_err() {
                shared.set_error(Some("input sink panicked".to_owned()));
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_round_trips_through_its_byte() {
        for p in [
            InputPermission::Unknown,
            InputPermission::Granted,
            InputPermission::Denied,
            InputPermission::NotRequired,
        ] {
            assert_eq!(InputPermission::from_u8(p.to_u8()), p);
        }
        assert_eq!(InputPermission::from_u8(200), InputPermission::Unknown);
    }

    #[test]
    fn full_queue_drops_and_counts_instead_of_blocking() {
        let shared = Shared::new();
        let (tx, _rx) = mpsc::sync_channel(2);
        let event_tx = EventTx {
            tx,
            shared: Arc::clone(&shared),
        };
        for _ in 0..5 {
            event_tx.send(InputEvent::KeyDown);
        }
        assert_eq!(shared.snapshot().dropped_events, 3);
    }

    #[test]
    fn dispatcher_delivers_in_order_and_survives_a_panicking_sink() {
        use std::sync::atomic::AtomicUsize;
        let shared = Shared::new();
        let seen = Arc::new(AtomicUsize::new(0));
        let seen_in_sink = Arc::clone(&seen);
        let sink: Arc<dyn InputSink> = Arc::new(move |event: InputEvent| {
            let n = seen_in_sink.fetch_add(1, Ordering::SeqCst);
            assert!(n != 0, "first event panics on purpose");
            assert_eq!(event, InputEvent::Wheel);
        });
        let (tx, rx) = mpsc::sync_channel(8);
        let handle = spawn_dispatcher(rx, sink, Arc::clone(&shared));
        for _ in 0..3 {
            tx.send(InputEvent::Wheel).ok();
        }
        drop(tx);
        handle.join().ok();
        assert_eq!(seen.load(Ordering::SeqCst), 3);
        assert_eq!(
            shared.snapshot().last_error.as_deref(),
            Some("input sink panicked")
        );
    }
}
