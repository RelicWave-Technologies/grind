//! Screen-lock and screensaver state shared between the session-event thread
//! (which writes it) and `idle::system_idle_state` (which reads it).
//!
//! Electron tracks the same two bits the same way: Chromium's
//! `MacScreenMonitor` / `SessionLockedObserver` flip a flag on the OS
//! notification, and `getSystemIdleState` reads the flag. Until a
//! [`crate::power::PowerMonitor`] is running nothing updates them, exactly as
//! Electron's state is blind before `ui::InitIdleMonitor()`.

use std::sync::atomic::{AtomicBool, Ordering};

static LOCKED: AtomicBool = AtomicBool::new(false);
static SCREENSAVER: AtomicBool = AtomicBool::new(false);

pub(crate) fn set_locked(locked: bool) {
    LOCKED.store(locked, Ordering::SeqCst);
}

pub(crate) fn set_screensaver(running: bool) {
    SCREENSAVER.store(running, Ordering::SeqCst);
}

/// Reset when the monitor stops: a stale "locked" must not outlive its source.
pub(crate) fn reset() {
    set_locked(false);
    set_screensaver(false);
}

/// macOS: `screensaverRunning || screenLocked`.
#[cfg_attr(
    not(target_os = "macos"),
    allow(dead_code, reason = "macOS reads both flags")
)]
pub(crate) fn locked_or_screensaver() -> bool {
    LOCKED.load(Ordering::SeqCst) || SCREENSAVER.load(Ordering::SeqCst)
}

/// Windows: `IsWorkstationLocked()`; the screensaver half is queried live.
#[cfg_attr(
    not(target_os = "windows"),
    allow(dead_code, reason = "Windows reads the lock flag")
)]
pub(crate) fn locked() -> bool {
    LOCKED.load(Ordering::SeqCst)
}
