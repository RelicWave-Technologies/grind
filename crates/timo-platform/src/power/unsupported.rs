//! Targets other than macOS and Windows: explicit, never fake.

use std::sync::Arc;

use super::PowerSink;
use crate::PlatformError;

#[derive(Debug)]
pub(super) struct Backend;

impl Backend {
    pub(super) fn start(_sink: Arc<dyn PowerSink>) -> Result<Self, PlatformError> {
        Err(PlatformError::Unsupported("power and session events"))
    }

    pub(super) fn stop(&mut self) {}
}
