//! System idle time and state, with Electron's exact semantics.
//!
//! Port of `powerMonitor.getSystemIdleTime()` and `getSystemIdleState(threshold)`
//! (Electron 33.2.0 / Chromium 130 `ui/base/idle`). Sources are listed in
//! `ELECTRON-PARITY.md`.

use crate::PlatformError;

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

/// The values `getSystemIdleState` resolves to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IdleState {
    Active,
    Idle,
    Locked,
    /// Electron maps any state it does not recognise to this; Chromium's
    /// `CalculateIdleState` never produces it, so it is here for the string map only.
    Unknown,
}

impl IdleState {
    /// The exact string Electron hands to JavaScript.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Idle => "idle",
            Self::Locked => "locked",
            Self::Unknown => "unknown",
        }
    }
}

/// Seconds since the last keyboard/mouse input, as a whole number.
///
/// Port of `powerMonitor.getSystemIdleTime()` → `ui::CalculateIdleTime()`.
pub fn system_idle_seconds() -> Result<i32, PlatformError> {
    imp::idle_seconds()
}

/// Port of `powerMonitor.getSystemIdleState(threshold)` → `ui::CalculateIdleState`.
///
/// Electron throws unless `threshold > 0`; this returns
/// [`PlatformError::InvalidIdleThreshold`] for the same inputs.
pub fn system_idle_state(threshold_secs: i32) -> Result<IdleState, PlatformError> {
    if threshold_secs <= 0 {
        return Err(PlatformError::InvalidIdleThreshold(threshold_secs));
    }
    let locked = imp::is_locked()?;
    let idle = imp::idle_seconds()?;
    Ok(decide_state(locked, idle, threshold_secs))
}

/// Chromium's `CalculateIdleState`, with the OS reads already done.
///
/// Locked wins over idle; idle is `>=` the threshold (not `>`).
#[must_use]
pub fn decide_state(locked: bool, idle_secs: i32, threshold_secs: i32) -> IdleState {
    if locked {
        IdleState::Locked
    } else if idle_secs >= threshold_secs {
        IdleState::Idle
    } else {
        IdleState::Active
    }
}

/// macOS: `static_cast<int>(CGEventSourceSecondsSinceLastEventType(..))`.
///
/// Truncates toward zero. Out-of-range input is undefined behaviour in C++;
/// we use arm64's behaviour (what Electron does on Apple Silicon): saturate,
/// and NaN becomes 0. Rust's float-to-int `as` is defined to do exactly that.
#[must_use]
#[allow(
    clippy::as_conversions,
    clippy::cast_possible_truncation,
    reason = "saturating float→int is the defined behaviour we want to mirror; no safe std equivalent"
)]
pub fn mac_idle_seconds(raw_seconds: f64) -> i32 {
    raw_seconds as i32
}

/// Windows: Chromium's `CalculateIdleTimeInternal`, from `GetLastInputInfo().dwTime`
/// and `GetTickCount()` (both 32-bit millisecond tick counts).
///
/// A tick count wraps every 49.7 days; Chromium assumes it wrapped once and adds
/// `(MAX - last) + now`. Note that sum is one millisecond short of the true gap
/// (it should be `MAX - last + now + 1`); we keep Chromium's arithmetic.
#[must_use]
pub fn windows_idle_seconds(last_input_tick: u32, now_tick: u32) -> i32 {
    let idle_ms = if now_tick < last_input_tick {
        (u32::MAX - last_input_tick).wrapping_add(now_tick)
    } else {
        now_tick - last_input_tick
    };
    i32::try_from(idle_ms / 1000).unwrap_or(i32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_strings_match_electron() {
        assert_eq!(IdleState::Active.as_str(), "active");
        assert_eq!(IdleState::Idle.as_str(), "idle");
        assert_eq!(IdleState::Locked.as_str(), "locked");
        assert_eq!(IdleState::Unknown.as_str(), "unknown");
    }

    #[test]
    fn locked_beats_idle_and_idle_is_inclusive() {
        assert_eq!(decide_state(true, 9_999, 30), IdleState::Locked);
        assert_eq!(decide_state(false, 30, 30), IdleState::Idle);
        assert_eq!(decide_state(false, 29, 30), IdleState::Active);
        assert_eq!(decide_state(false, 0, 1), IdleState::Active);
    }

    #[test]
    fn non_positive_threshold_is_rejected_like_electron() {
        assert!(matches!(
            system_idle_state(0),
            Err(PlatformError::InvalidIdleThreshold(0))
        ));
        assert!(matches!(
            system_idle_state(-5),
            Err(PlatformError::InvalidIdleThreshold(-5))
        ));
    }

    #[test]
    fn mac_seconds_truncate_toward_zero() {
        assert_eq!(mac_idle_seconds(0.0), 0);
        assert_eq!(mac_idle_seconds(0.999_999), 0);
        assert_eq!(mac_idle_seconds(1.0), 1);
        assert_eq!(mac_idle_seconds(29.99), 29);
        assert_eq!(mac_idle_seconds(1799.5), 1799);
    }

    #[test]
    fn mac_seconds_saturate_and_nan_is_zero() {
        assert_eq!(mac_idle_seconds(1.0e19), i32::MAX);
        assert_eq!(mac_idle_seconds(f64::INFINITY), i32::MAX);
        assert_eq!(mac_idle_seconds(f64::NAN), 0);
    }

    #[test]
    fn windows_seconds_floor_the_millisecond_gap() {
        assert_eq!(windows_idle_seconds(1_000, 1_000), 0);
        assert_eq!(windows_idle_seconds(1_000, 1_999), 0);
        assert_eq!(windows_idle_seconds(1_000, 2_000), 1);
        assert_eq!(windows_idle_seconds(0, 61_000), 61);
    }

    #[test]
    fn windows_tick_wrap_uses_chromiums_arithmetic() {
        // last = MAX - 500, now = 499 → (MAX - last) + now = 500 + 499 = 999 ms.
        assert_eq!(windows_idle_seconds(u32::MAX - 500, 499), 0);
        // 2999 ms across the wrap → 2 s.
        assert_eq!(windows_idle_seconds(u32::MAX - 1_000, 1_999), 2);
    }
}
