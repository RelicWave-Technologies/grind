//! One error type for the whole crate.

use std::fmt;

/// The OS permissions Timo depends on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PermissionKind {
    /// macOS Accessibility (`AXIsProcessTrusted`).
    Accessibility,
    /// macOS Input Monitoring (`kTCCServiceListenEvent`).
    InputMonitoring,
    /// macOS Screen Recording (`kTCCServiceScreenCapture`).
    ScreenRecording,
}

impl fmt::Display for PermissionKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Accessibility => "Accessibility",
            Self::InputMonitoring => "Input Monitoring",
            Self::ScreenRecording => "Screen Recording",
        })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PlatformError {
    /// This target has no implementation. Returned instead of made-up data.
    #[error("{0} is not supported on this platform")]
    Unsupported(&'static str),
    /// The OS refused because a permission is missing.
    #[error("{0} permission is not granted")]
    PermissionDenied(PermissionKind),
    /// An OS call failed.
    #[error("{what} failed: {detail}")]
    Os { what: &'static str, detail: String },
    /// A listener of this kind is already running in this process.
    #[error("{0} is already running")]
    AlreadyRunning(&'static str),
    /// Electron rejects an idle threshold that is not above zero.
    #[error("invalid idle threshold {0}: must be greater than 0")]
    InvalidIdleThreshold(i32),
}

impl PlatformError {
    pub(crate) fn os(what: &'static str, detail: impl fmt::Display) -> Self {
        Self::Os {
            what,
            detail: detail.to_string(),
        }
    }
}
