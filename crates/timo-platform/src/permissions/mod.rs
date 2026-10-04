//! OS permissions and the Settings panes that grant them.
//!
//! macOS needs three independent grants (Accessibility, Input Monitoring, Screen
//! Recording — separate TCC rows, none implies another). Windows needs none, so
//! every query reports "granted" there, as legacy does for every non-macOS
//! platform. Other targets return [`PlatformError::Unsupported`].
//!
//! Ports of `legacy/agent/src/main/services/permissions.ts` and the openers in
//! `ipc/settings.ts`.

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

/// `systemPreferences.getMediaAccessStatus('screen')`'s possible strings.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScreenStatus {
    Granted,
    Denied,
    Restricted,
    NotDetermined,
    Unknown,
}

impl ScreenStatus {
    /// The exact string legacy's `ScreenStatus` type holds.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Granted => "granted",
            Self::Denied => "denied",
            Self::Restricted => "restricted",
            Self::NotDetermined => "not-determined",
            Self::Unknown => "unknown",
        }
    }

    /// Electron 33's mapping for `'screen'`: Chromium's
    /// `CheckSystemScreenCapturePermission` is `CGPreflightScreenCaptureAccess() ?
    /// kAllowed : kDenied`, and `ConvertSystemPermission` turns those into
    /// `"granted"` / `"denied"`. It can never report `not-determined` or
    /// `restricted` for screen capture — legacy's handling of those two is
    /// unreachable on this Electron.
    #[must_use]
    pub fn from_preflight(allowed: bool) -> Self {
        if allowed { Self::Granted } else { Self::Denied }
    }
}

/// A System Settings destination legacy opens.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettingsPane {
    ScreenRecording,
    InputMonitoring,
    Accessibility,
    /// Login Items (macOS) / Startup apps (Windows).
    StartupApps,
}

/// What `open_settings` did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenOutcome {
    Opened,
    /// This pane has no equivalent on this OS (legacy's `if (process.platform === …)` guards).
    NotApplicable,
}

/// The `x-apple.systempreferences:` URL legacy passes to `shell.openExternal`.
#[must_use]
pub fn mac_settings_url(pane: SettingsPane) -> &'static str {
    match pane {
        SettingsPane::ScreenRecording => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        }
        SettingsPane::InputMonitoring => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
        }
        SettingsPane::Accessibility => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        }
        SettingsPane::StartupApps => {
            "x-apple.systempreferences:com.apple.LoginItems-Settings.extension"
        }
    }
}

/// Windows destinations: legacy has exactly one (`ms-settings:startupapps`);
/// the other panes are macOS-only grants and legacy does nothing for them.
#[must_use]
pub fn windows_settings_url(pane: SettingsPane) -> Option<&'static str> {
    match pane {
        SettingsPane::StartupApps => Some("ms-settings:startupapps"),
        SettingsPane::ScreenRecording
        | SettingsPane::InputMonitoring
        | SettingsPane::Accessibility => None,
    }
}

/// `systemPreferences.isTrustedAccessibilityClient(prompt)`. With `prompt`, macOS
/// shows its dialog and registers the app in the Accessibility list.
pub fn accessibility_trusted(prompt: bool) -> Result<bool, PlatformError> {
    imp::accessibility_trusted(prompt)
}

/// `CGPreflightListenEventAccess()`: is Input Monitoring granted? Never prompts.
pub fn input_monitoring_granted() -> Result<bool, PlatformError> {
    imp::input_monitoring_granted()
}

/// `CGRequestListenEventAccess()`: ask for Input Monitoring. macOS shows its
/// prompt at most once per app; afterwards only the Settings pane can grant it.
pub fn request_input_monitoring() -> Result<bool, PlatformError> {
    imp::request_input_monitoring()
}

/// `CGPreflightScreenCaptureAccess()`.
pub fn screen_recording_granted() -> Result<bool, PlatformError> {
    imp::screen_recording_granted()
}

/// `CGRequestScreenCaptureAccess()`: ask for Screen Recording (same once-only rule).
pub fn request_screen_recording() -> Result<bool, PlatformError> {
    imp::request_screen_recording()
}

/// `systemPreferences.getMediaAccessStatus('screen')`.
///
/// Electron 33 can hand back a stale value after the user toggles the setting,
/// until the app restarts; this is the same call, so it inherits that.
pub fn screen_status() -> Result<ScreenStatus, PlatformError> {
    Ok(ScreenStatus::from_preflight(
        imp::screen_recording_granted()?
    ))
}

/// Open a Settings pane the way legacy's `shell.openExternal` does.
pub fn open_settings(pane: SettingsPane) -> Result<OpenOutcome, PlatformError> {
    imp::open_settings(pane)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn screen_status_strings_match_legacy_type() {
        assert_eq!(ScreenStatus::Granted.as_str(), "granted");
        assert_eq!(ScreenStatus::Denied.as_str(), "denied");
        assert_eq!(ScreenStatus::Restricted.as_str(), "restricted");
        assert_eq!(ScreenStatus::NotDetermined.as_str(), "not-determined");
        assert_eq!(ScreenStatus::Unknown.as_str(), "unknown");
    }

    #[test]
    fn preflight_maps_only_to_granted_or_denied() {
        assert_eq!(ScreenStatus::from_preflight(true), ScreenStatus::Granted);
        assert_eq!(ScreenStatus::from_preflight(false), ScreenStatus::Denied);
    }

    #[test]
    fn mac_urls_are_the_ones_legacy_opens() {
        assert_eq!(
            mac_settings_url(SettingsPane::ScreenRecording),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        );
        assert_eq!(
            mac_settings_url(SettingsPane::InputMonitoring),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
        );
        assert_eq!(
            mac_settings_url(SettingsPane::Accessibility),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        );
        assert_eq!(
            mac_settings_url(SettingsPane::StartupApps),
            "x-apple.systempreferences:com.apple.LoginItems-Settings.extension"
        );
    }

    #[test]
    fn windows_has_exactly_one_destination() {
        assert_eq!(
            windows_settings_url(SettingsPane::StartupApps),
            Some("ms-settings:startupapps")
        );
        assert_eq!(windows_settings_url(SettingsPane::ScreenRecording), None);
        assert_eq!(windows_settings_url(SettingsPane::InputMonitoring), None);
        assert_eq!(windows_settings_url(SettingsPane::Accessibility), None);
    }
}
