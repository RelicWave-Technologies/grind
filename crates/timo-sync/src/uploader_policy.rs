//! What to do when a screenshot upload fails. Port of the policy half of
//! `legacy/agent/src/main/services/capture/uploader.ts` (SC-73):
//! `screenshotRetryDelayMs` and `screenshotUploadFailureDecision`, plus the
//! error classification they read (`isNonCountingFailure`, `isTerminalFailure`).

use timo_core::js::math::mul;
use timo_core::js::number::{add, floor, min};

use crate::error::ApiError;

/// Stop retrying a shot after this many failed attempts (Cloudinary/network).
pub const MAX_ATTEMPTS: i64 = 5;
const RETRY_MIN_MS: f64 = 60_000.0;
const RETRY_MAX_MS: f64 = 3_600_000.0;

/// Everything `uploadOne` can throw, as far as the policy tells them apart.
#[derive(Debug, Clone)]
pub enum UploadError {
    /// `api()` threw: `HttpError`, `UnauthorizedError`, timeout, network.
    Api(ApiError),
    /// `CloudinaryUploadError(status, body)`.
    Cloudinary { status: u16, body: String },
    /// The local file is gone: Node's `ENOENT`.
    LocalFileMissing { path: String },
    /// Any other thrown error: its message (`cloudinary response missing secure_url`).
    Other(String),
}

impl UploadError {
    /// `errText(err)`: `err.message`.
    #[must_use]
    pub fn message(&self) -> String {
        match self {
            Self::Api(err) => err.message(),
            Self::Cloudinary { status, body } => {
                format!("cloudinary {status}: {}", first_utf16_units(body, 200))
            }
            Self::LocalFileMissing { path } => {
                format!("ENOENT: no such file or directory, open '{path}'")
            }
            Self::Other(message) => message.clone(),
        }
    }

    /// `isStorageUnavailable`: a 503, or a message naming unconfigured storage.
    fn is_storage_unavailable(&self) -> bool {
        let message = self.message();
        matches!(self, Self::Api(err) if err.is_http_status(503))
            || message.contains("cloudinary_not_configured")
            || message.contains("storage_not_configured")
    }

    /// `isNonCountingFailure`: costs the shot no attempt.
    #[must_use]
    pub fn is_non_counting(&self) -> bool {
        matches!(self, Self::Api(err) if err.is_unauthorized()) || self.is_storage_unavailable()
    }

    /// `isTerminalFailure`: retrying cannot help.
    fn is_terminal(&self) -> bool {
        match self {
            Self::LocalFileMissing { .. } => true,
            Self::Cloudinary { status, .. } => {
                (400..500).contains(status) && *status != 408 && *status != 429
            }
            _ => false,
        }
    }
}

/// `body.slice(0, n)` on UTF-16 code units (a cut pair becomes U+FFFD, which is
/// what SQLite ends up storing for the lone surrogate JavaScript would keep).
fn first_utf16_units(text: &str, n: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    String::from_utf16_lossy(units.get(..n).unwrap_or(&units))
}

/// Port of `screenshotRetryDelayMs(attemptsAfterFailure, rng)`: capped
/// exponential backoff with a one-minute floor and jitter.
#[must_use]
pub fn screenshot_retry_delay_ms(attempts_after_failure: i64, rng: &mut dyn FnMut() -> f64) -> f64 {
    let exponent = i32::try_from((attempts_after_failure - 1).max(0)).unwrap_or(i32::MAX);
    let capped = min(RETRY_MAX_MS, mul(RETRY_MIN_MS, 2.0_f64.powi(exponent)));
    if capped <= RETRY_MIN_MS {
        return RETRY_MIN_MS;
    }
    let span = timo_core::js::number::sub(capped, RETRY_MIN_MS);
    floor(add(RETRY_MIN_MS, mul(rng(), span)))
}

/// `ScreenshotUploadFailureDecision`.
#[derive(Debug, Clone, PartialEq)]
pub enum UploadFailureDecision {
    /// Back to pending, no attempt consumed.
    Pending {
        last_error: String,
        next_attempt_at: f64,
    },
    /// Back to pending with backoff, one attempt consumed.
    Retry {
        last_error: String,
        next_attempt_at: f64,
    },
    Failed {
        last_error: String,
    },
}

/// Port of `screenshotUploadFailureDecision(row, err, now, rng)`; `attempts` is
/// the row's attempts so far.
#[must_use]
pub fn screenshot_upload_failure_decision(
    attempts: i64,
    err: &UploadError,
    now: f64,
    rng: &mut dyn FnMut() -> f64,
) -> UploadFailureDecision {
    let message = err.message();
    if err.is_non_counting() {
        return UploadFailureDecision::Pending {
            last_error: message,
            next_attempt_at: add(now, RETRY_MIN_MS),
        };
    }
    let after = attempts + 1;
    if err.is_terminal() || after >= MAX_ATTEMPTS {
        return UploadFailureDecision::Failed {
            last_error: message,
        };
    }
    UploadFailureDecision::Retry {
        last_error: message,
        next_attempt_at: add(now, screenshot_retry_delay_ms(after, rng)),
    }
}
