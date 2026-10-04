//! The errors the timezone functions throw.

use thiserror::Error;

/// What `packages/types/src/timezone.ts` throws. The `Display` text is the
/// TypeScript message byte for byte (`LocalTimeResolutionError` carries its
/// code as its message), which is what the parity fixtures compare.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum TzError {
    /// `new Error('invalid_date_or_timezone')`: the instant is NaN/out of range
    /// or the zone id is not one `Intl` accepts.
    #[error("invalid_date_or_timezone")]
    InvalidDateOrTimezone,
    /// `new Error('invalid_timezone')`.
    #[error("invalid_timezone")]
    InvalidTimezone,
    /// `LocalTimeResolutionError('invalid_local_time')`: the parts do not
    /// round-trip through `Date.UTC` (month 13, Feb 30, hour 24, year 0..99).
    #[error("invalid_local_time")]
    InvalidLocalTime,
    /// `LocalTimeResolutionError('nonexistent_local_time')`: a spring-forward gap.
    #[error("nonexistent_local_time")]
    NonexistentLocalTime,
}
