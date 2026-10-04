//! Port of the policy functions of
//! `legacy/agent/src/main/services/capture/uploader.ts`:
//! `screenshotRetryDelayMs` and `screenshotUploadFailureDecision`, with the
//! random source and the clock injected.

use serde::{Deserialize, Serialize};

use crate::js::math::mul;
use crate::js::number::{add, floor, max, min, number_to_string, strict_eq, sub};

/// Stop retrying a shot after this many failed attempts.
const MAX_ATTEMPTS: f64 = 5.0;
const RETRY_MIN_MS: f64 = 60_000.0;
const RETRY_MAX_MS: f64 = 3_600_000.0;

/// What can be thrown at the upload code. The TypeScript branches on
/// `instanceof` and on a `code` property, so each shape is a variant.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UploadError {
    /// `UnauthorizedError(message)`.
    Unauthorized { message: String },
    /// `HttpError(path, status, body)`: message `${path} ${status}: ${body}`.
    Http {
        path: String,
        status: f64,
        body: String,
    },
    /// `CloudinaryUploadError(status, body)`: message
    /// `cloudinary ${status}: ${body.slice(0, 200)}`.
    Cloudinary { status: f64, body: String },
    /// Any other `Error`, optionally carrying a `code` (Node fs errors do).
    Error {
        message: String,
        code: Option<String>,
    },
    /// A thrown object that is not an `Error` (`String(err)` is
    /// `[object Object]`), optionally carrying a `code`.
    Plain { code: Option<String> },
    /// A thrown primitive; `String(err)` is the text.
    Text { text: String },
}

/// `body.slice(0, 200)`: 200 UTF-16 code units. A cut inside a surrogate pair
/// would leave a lone surrogate, which a Rust string cannot hold; that half is
/// dropped (see `PARITY.md`).
fn slice_utf16(s: &str, units: usize) -> String {
    let mut used = 0;
    let mut out = String::new();
    for c in s.chars() {
        used += c.len_utf16();
        if used > units {
            break;
        }
        out.push(c);
    }
    out
}

impl UploadError {
    /// `errText(err)`.
    fn text(&self) -> String {
        match self {
            Self::Unauthorized { message } | Self::Error { message, .. } => message.clone(),
            Self::Http { path, status, body } => {
                format!("{path} {}: {body}", number_to_string(*status))
            }
            Self::Cloudinary { status, body } => {
                format!(
                    "cloudinary {}: {}",
                    number_to_string(*status),
                    slice_utf16(body, 200)
                )
            }
            Self::Plain { .. } => "[object Object]".to_owned(),
            Self::Text { text } => text.clone(),
        }
    }

    /// `isStorageUnavailable`.
    fn is_storage_unavailable(&self) -> bool {
        let msg = self.text();
        matches!(self, Self::Http { status, .. } if strict_eq(*status, 503.0))
            || msg.contains("cloudinary_not_configured")
            || msg.contains("storage_not_configured")
    }

    /// `isNonCountingFailure`.
    fn is_non_counting(&self) -> bool {
        matches!(self, Self::Unauthorized { .. }) || self.is_storage_unavailable()
    }

    /// `isLocalFileMissing`: an object whose `code` is `'ENOENT'`.
    fn is_local_file_missing(&self) -> bool {
        match self {
            Self::Error { code, .. } | Self::Plain { code } => code.as_deref() == Some("ENOENT"),
            _ => false,
        }
    }

    /// `isTerminalFailure`.
    fn is_terminal(&self) -> bool {
        if self.is_local_file_missing() {
            return true;
        }
        match self {
            Self::Cloudinary { status, .. } => {
                *status >= 400.0
                    && *status < 500.0
                    && !strict_eq(*status, 408.0)
                    && !strict_eq(*status, 429.0)
            }
            _ => false,
        }
    }
}

/// Port of `screenshotRetryDelayMs(attemptsAfterFailure, rng)`.
pub fn screenshot_retry_delay_ms(attempts_after_failure: f64, mut rng: impl FnMut() -> f64) -> f64 {
    let exponent = max(0.0, sub(attempts_after_failure, 1.0));
    let capped = min(RETRY_MAX_MS, mul(RETRY_MIN_MS, pow2(exponent)));
    if capped <= RETRY_MIN_MS {
        return RETRY_MIN_MS;
    }
    floor(add(RETRY_MIN_MS, mul(rng(), sub(capped, RETRY_MIN_MS))))
}

/// `2 ** n` for `n >= 0`. Whole exponents are exact powers of two; `powf` covers
/// the fractional case, which no caller produces (attempt counts are whole).
fn pow2(n: f64) -> f64 {
    if strict_eq(n.fract(), 0.0) {
        i32::try_from(crate::js::number::f64_to_i64(n).unwrap_or(i64::MAX))
            .map_or(f64::INFINITY, |e| 2f64.powi(e))
    } else {
        2f64.powf(n)
    }
}

/// Port of `ScreenshotUploadFailureDecision`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ScreenshotUploadFailureDecision {
    Pending {
        last_error: String,
        next_attempt_at: f64,
    },
    Retry {
        last_error: String,
        next_attempt_at: f64,
    },
    Failed {
        last_error: String,
    },
}

/// Port of `screenshotUploadFailureDecision(row, err, now, rng)`; `attempts` is
/// `row.attempts`.
pub fn screenshot_upload_failure_decision(
    attempts: f64,
    err: &UploadError,
    now: f64,
    rng: impl FnMut() -> f64,
) -> ScreenshotUploadFailureDecision {
    let message = err.text();
    if err.is_non_counting() {
        return ScreenshotUploadFailureDecision::Pending {
            last_error: message,
            next_attempt_at: add(now, RETRY_MIN_MS),
        };
    }
    let attempts_after_failure = add(attempts, 1.0);
    if err.is_terminal() || attempts_after_failure >= MAX_ATTEMPTS {
        return ScreenshotUploadFailureDecision::Failed {
            last_error: message,
        };
    }
    ScreenshotUploadFailureDecision::Retry {
        last_error: message,
        next_attempt_at: add(now, screenshot_retry_delay_ms(attempts_after_failure, rng)),
    }
}
