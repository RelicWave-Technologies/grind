//! What the timer engine can fail with.
//!
//! The TypeScript throws bare `Error`s whose message is the contract
//! (`timer_owner_unavailable`, `sqlite_write_failed`, ...), so every variant's
//! `Display` is that message, byte for byte.

use thiserror::Error;

use super::types::TrackingReadiness;
use crate::error::CoreError;

/// Port of `trackingReadiness.ts::TrackingBlockedError` and any other rejection
/// of `TrackingAccrualGuard.assertCanAccrue()`.
#[derive(Debug, Clone, PartialEq, Error)]
pub enum GuardError {
    /// `TrackingBlockedError`: `code === 'TRACKING_PERMISSIONS_REQUIRED'`.
    #[error("Tracking permissions are required")]
    Blocked(Box<TrackingReadiness>),
    /// Any other thrown error: its message.
    #[error("{0}")]
    Other(String),
}

impl GuardError {
    /// The `code` property of `TrackingBlockedError`, if this is one.
    #[must_use]
    pub const fn code(&self) -> Option<&'static str> {
        match self {
            Self::Blocked(_) => Some("TRACKING_PERMISSIONS_REQUIRED"),
            Self::Other(_) => None,
        }
    }
}

/// A rejection of `SyncClient.create/sync`. `HttpError` carries a status;
/// anything else (network down, schema failure) is `Other`.
#[derive(Debug, Clone, PartialEq, Error)]
pub enum SyncError {
    /// `HttpError(path, status, body)`: message is `${path} ${status}: ${body}`.
    #[error("{path} {status}: {body}")]
    Http {
        path: String,
        status: u16,
        body: String,
    },
    /// Any other thrown error: its message.
    #[error("{0}")]
    Other(String),
}

impl SyncError {
    /// `err instanceof HttpError && err.status === 404`.
    #[must_use]
    pub const fn is_not_found(&self) -> bool {
        matches!(self, Self::Http { status: 404, .. })
    }
}

/// Everything a timer operation can throw.
#[derive(Debug, Clone, PartialEq, Error)]
pub enum TimerError {
    /// A `SegmentError` (or another `timo-core` error) from the pure logic.
    #[error(transparent)]
    Core(#[from] CoreError),
    /// `new Error('timer_owner_unavailable')`.
    #[error("timer_owner_unavailable")]
    OwnerUnavailable,
    /// `new Error('timer_owner_mismatch')`.
    #[error("timer_owner_mismatch")]
    OwnerMismatch,
    /// `new Error('timer_entry_owned_by_another_session')`.
    #[error("timer_entry_owned_by_another_session")]
    EntryOwnedByAnotherSession,
    /// The accrual guard refused.
    #[error(transparent)]
    Guard(#[from] GuardError),
    /// V8's `TypeError` when `resumeFromIdle` reads `this.open.endedAt` after
    /// the guard await found the entry gone (see `CONCURRENCY.md`).
    #[error("Cannot read properties of null (reading 'endedAt')")]
    NullEntry,
    /// V8's `TypeError` reading `segments[0].startedAt` of an entry with no
    /// segments (only a corrupt legacy row can have none).
    #[error("Cannot read properties of undefined (reading 'startedAt')")]
    EmptySegments,
    /// A store failure that is not one of the named ones (SQLite's message).
    #[error("{0}")]
    Store(String),
}
