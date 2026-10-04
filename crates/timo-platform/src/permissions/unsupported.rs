//! Targets other than macOS and Windows: explicit, never fake.

use super::{OpenOutcome, SettingsPane};
use crate::PlatformError;

const WHAT: &str = "OS permission checks";

pub(super) fn accessibility_trusted(_prompt: bool) -> Result<bool, PlatformError> {
    Err(PlatformError::Unsupported(WHAT))
}

pub(super) fn input_monitoring_granted() -> Result<bool, PlatformError> {
    Err(PlatformError::Unsupported(WHAT))
}

pub(super) fn request_input_monitoring() -> Result<bool, PlatformError> {
    Err(PlatformError::Unsupported(WHAT))
}

pub(super) fn screen_recording_granted() -> Result<bool, PlatformError> {
    Err(PlatformError::Unsupported(WHAT))
}

pub(super) fn request_screen_recording() -> Result<bool, PlatformError> {
    Err(PlatformError::Unsupported(WHAT))
}

pub(super) fn open_settings(_pane: SettingsPane) -> Result<OpenOutcome, PlatformError> {
    Err(PlatformError::Unsupported("opening System Settings"))
}
