//! Power and session events: suspend, resume, screen lock/unlock, shutdown.
//!
//! Equivalent of the `powerMonitor` events `legacy/agent/src/main/services/power.ts`
//! subscribes to (`suspend`, `resume`, `lock-screen`, `unlock-screen`, `shutdown`).
//! Which OS notification each maps to is in `ELECTRON-PARITY.md`.
//!
//! # Threading and delivery
//!
//! A [`PowerMonitor`] owns one dedicated thread that receives the OS
//! notifications (macOS: a `CFRunLoop`; Windows: a hidden message-only window and
//! its `GetMessageW` pump). Your [`PowerSink`] is called **synchronously on that
//! thread, before the OS is told it may proceed** — on macOS before
//! `IOAllowPowerChange`, on Windows before the window procedure returns.
//!
//! **macOS needs the main run loop running.** Foundation delivers the lock,
//! screensaver and power-off notifications on the main thread, so a host whose main
//! thread never runs its run loop never sees them. A Tauri/AppKit app does; a bare
//! `main` must pump it (`examples/probe.rs` does). The monitor then hands each one
//! to its own thread, so the sink is still only ever called there.
//!
//! That ordering is the reliability guarantee: legacy stamps "when did the user
//! go away" with `Date.now()` inside the `suspend` handler, and a handler that
//! ran after the machine had slept would bill the whole sleep. So the sink must
//! read its clock, queue the event and return — do real work elsewhere. A sink
//! that blocks delays sleep (macOS allows up to 30 s) or shutdown. Panics in the
//! sink are contained and logged; they never stop delivery or power transitions.
//!
//! Events from one source arrive in the order the OS emitted them. On macOS the
//! lock and shutdown notifications take a hop through the main thread, so they can
//! arrive a moment after a suspend/resume that the OS emitted later.

use std::sync::Arc;

use crate::PlatformError;

#[cfg(target_os = "macos")]
mod mac;
#[cfg(target_os = "macos")]
use mac as imp;

#[cfg(target_os = "windows")]
mod win_session;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
use windows as imp;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod unsupported;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
use unsupported as imp;

/// The `powerMonitor` events legacy listens to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PowerEvent {
    /// `suspend`
    Suspend,
    /// `resume`
    Resume,
    /// `lock-screen`
    LockScreen,
    /// `unlock-screen`
    UnlockScreen,
    /// `shutdown`: the machine is powering off or the user is logging out. Emitted on
    /// macOS only, as in Electron 33; on Windows session end is the app layer's.
    Shutdown,
}

impl PowerEvent {
    /// The Electron event name this stands for.
    #[must_use]
    pub fn electron_name(self) -> &'static str {
        match self {
            Self::Suspend => "suspend",
            Self::Resume => "resume",
            Self::LockScreen => "lock-screen",
            Self::UnlockScreen => "unlock-screen",
            Self::Shutdown => "shutdown",
        }
    }
}

/// Receives power events; see the module docs for the calling contract.
pub trait PowerSink: Send + Sync + 'static {
    fn on_power(&self, event: PowerEvent);
}

impl<F> PowerSink for F
where
    F: Fn(PowerEvent) + Send + Sync + 'static,
{
    fn on_power(&self, event: PowerEvent) {
        self(event);
    }
}

/// A running power/session monitor. Dropping it stops it.
///
/// Start one at launch and keep it for the life of the app: it is also what
/// keeps `idle::system_idle_state` aware of lock and screensaver.
#[derive(Debug)]
pub struct PowerMonitor {
    backend: Option<imp::Backend>,
}

impl PowerMonitor {
    /// Register with the OS and return once registration has succeeded or failed.
    pub fn start(sink: Arc<dyn PowerSink>) -> Result<Self, PlatformError> {
        let backend = imp::Backend::start(sink)?;
        Ok(Self {
            backend: Some(backend),
        })
    }

    /// Unregister and join the monitor thread. Idempotent.
    pub fn stop(&mut self) {
        if let Some(mut backend) = self.backend.take() {
            backend.stop();
        }
        crate::session::reset();
    }
}

impl Drop for PowerMonitor {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Call the sink, containing any panic so it cannot unwind into OS callbacks.
pub(crate) fn deliver(sink: &dyn PowerSink, event: PowerEvent) {
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| sink.on_power(event)));
    if outcome.is_err() {
        tracing::error!(
            event = event.electron_name(),
            "power sink panicked; event dropped"
        );
    }
}

/// How long to wait before retrying `WTSRegisterSessionNotification`, if at all.
///
/// Only `RPC_S_INVALID_BINDING` (`transient`) is retried: it is what the call returns
/// when the app autostarts at logon before the RPC services are ready. `attempt` counts
/// the retries already made; after five, or for any other error, the failure is final.
#[cfg_attr(
    not(target_os = "windows"),
    allow(
        dead_code,
        reason = "only the Windows source registers for session notifications"
    )
)]
pub(crate) fn session_registration_retry_delay(
    transient: bool,
    attempt: u32,
) -> Option<std::time::Duration> {
    const DELAYS_MS: [u64; 5] = [250, 500, 1000, 2000, 4000];
    if !transient {
        return None;
    }
    let index = usize::try_from(attempt).ok()?;
    DELAYS_MS
        .get(index)
        .map(|&ms| std::time::Duration::from_millis(ms))
}

/// Chromium's `base::PowerMonitor` suspend/resume de-duplication.
///
/// `NotifySuspend` fires only if not already suspended; `NotifyResume` only if
/// currently suspended. macOS can deliver `kIOMessageSystemWillPowerOn` for dark
/// wakes that were never preceded by a sleep we reported, and those are dropped.
#[derive(Clone, Copy, Debug, Default)]
#[cfg_attr(
    not(target_os = "macos"),
    allow(dead_code, reason = "only the macOS source needs the gate")
)]
pub(crate) struct SuspendGate {
    suspended: bool,
}

#[cfg_attr(
    not(target_os = "macos"),
    allow(dead_code, reason = "only the macOS source needs the gate")
)]
impl SuspendGate {
    /// True if a `Suspend` should be emitted.
    pub(crate) fn on_suspend(&mut self) -> bool {
        if self.suspended {
            return false;
        }
        self.suspended = true;
        true
    }

    /// True if a `Resume` should be emitted.
    pub(crate) fn on_resume(&mut self) -> bool {
        if !self.suspended {
            return false;
        }
        self.suspended = false;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn electron_names_are_exact() {
        assert_eq!(PowerEvent::Suspend.electron_name(), "suspend");
        assert_eq!(PowerEvent::Resume.electron_name(), "resume");
        assert_eq!(PowerEvent::LockScreen.electron_name(), "lock-screen");
        assert_eq!(PowerEvent::UnlockScreen.electron_name(), "unlock-screen");
        assert_eq!(PowerEvent::Shutdown.electron_name(), "shutdown");
    }

    #[test]
    fn session_registration_retries_only_the_logon_race_and_gives_up() {
        use std::time::Duration;
        let total: Duration = (0..)
            .map_while(|n| session_registration_retry_delay(true, n))
            .sum();
        assert_eq!(total, Duration::from_millis(7750), "bounded backoff");
        assert_eq!(
            session_registration_retry_delay(true, 0),
            Some(Duration::from_millis(250))
        );
        assert_eq!(session_registration_retry_delay(true, 5), None);
        assert_eq!(
            session_registration_retry_delay(false, 0),
            None,
            "any other error is final"
        );
    }

    #[test]
    fn gate_dedupes_like_chromium() {
        let mut gate = SuspendGate::default();
        assert!(!gate.on_resume(), "resume before any suspend is dropped");
        assert!(gate.on_suspend());
        assert!(!gate.on_suspend(), "second suspend is dropped");
        assert!(gate.on_resume());
        assert!(!gate.on_resume(), "second resume is dropped");
        assert!(gate.on_suspend(), "a new cycle works");
    }

    #[test]
    fn deliver_contains_a_panicking_sink_and_keeps_going() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen_in_sink = Arc::clone(&seen);
        let sink = move |event: PowerEvent| {
            if let Ok(mut log) = seen_in_sink.lock() {
                log.push(event);
            }
            assert!(event != PowerEvent::Suspend, "sink blows up on suspend");
        };
        deliver(&sink, PowerEvent::Suspend);
        deliver(&sink, PowerEvent::Resume);
        let log = seen.lock().map(|l| l.clone()).unwrap_or_default();
        assert_eq!(log, vec![PowerEvent::Suspend, PowerEvent::Resume]);
    }
}
