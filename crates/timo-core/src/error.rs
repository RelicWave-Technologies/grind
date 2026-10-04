//! Errors the ported functions can return.

use thiserror::Error;

use crate::js::collate::CollatorError;

/// Everything a ported function can throw, plus the timestamp strings this port
/// declines to guess at (see `PARITY.md`).
#[derive(Debug, Clone, PartialEq, Error)]
pub enum CoreError {
    /// A `SegmentError`: the message is the TypeScript message, byte for byte.
    #[error("{0}")]
    Segment(String),
    /// `new Error('invalid_timer_timestamp')`: the timestamp parses to NaN.
    #[error("invalid_timer_timestamp")]
    InvalidTimerTimestamp,
    /// A timestamp string V8 would accept but this port does not parse.
    #[error("unsupported_timer_timestamp: {0:?}")]
    UnsupportedTimerTimestamp(String),
    /// The collation data failed to load.
    #[error(transparent)]
    Collator(#[from] CollatorError),
}
