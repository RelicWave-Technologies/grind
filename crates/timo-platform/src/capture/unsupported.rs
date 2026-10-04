//! Targets other than macOS and Windows: explicit, never fake.

use super::frame::RawFrame;
use crate::PlatformError;

const WHAT: &str = "screen capture";

/// Never constructed here: [`displays`] always fails first.
#[derive(Debug)]
pub(super) struct Display;

pub(super) fn displays() -> Result<Vec<Display>, PlatformError> {
    Err(PlatformError::Unsupported(WHAT))
}

impl Display {
    pub(super) fn display_id(&self) -> String {
        String::new()
    }

    pub(super) fn grab(&self) -> Result<Option<RawFrame>, PlatformError> {
        Err(PlatformError::Unsupported(WHAT))
    }
}
