//! Targets other than macOS and Windows: explicit, never fake.

use crate::PlatformError;

pub(super) fn idle_seconds() -> Result<i32, PlatformError> {
    Err(PlatformError::Unsupported("system idle time"))
}

pub(super) fn is_locked() -> Result<bool, PlatformError> {
    Err(PlatformError::Unsupported("screen lock state"))
}
