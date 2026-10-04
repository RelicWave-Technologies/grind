//! Targets other than macOS and Windows: explicit, never fake.

use std::sync::Arc;

use super::{EventTx, Shared};
use crate::PlatformError;

#[derive(Debug)]
pub(super) struct Backend;

impl Backend {
    pub(super) fn start(_tx: EventTx, _shared: Arc<Shared>) -> Result<Self, PlatformError> {
        Err(PlatformError::Unsupported("global input counting"))
    }

    pub(super) fn stop(&mut self) {}
}
