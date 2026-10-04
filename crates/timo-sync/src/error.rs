//! The errors `apiClient.ts` throws, and the ones it lets through.

use thiserror::Error;

use crate::tokens::TokenError;

/// Port of `apiClient.ts::{UnauthorizedError, HttpError}` plus the errors
/// `fetch` itself throws. `Display` is what `String(err)` prints in JavaScript
/// (`HttpError: /v1/x 409: body`), because callers match substrings of it.
#[derive(Debug, Clone, Error)]
pub enum ApiError {
    /// `UnauthorizedError(message)`: `no_tokens` or `refresh_failed`.
    #[error("UnauthorizedError: {0}")]
    Unauthorized(String),
    /// `HttpError(path, status, body)`; its message is `<path> <status>: <body>`.
    #[error("HttpError: {path} {status}: {body}")]
    Http {
        path: String,
        status: u16,
        body: String,
    },
    /// `AbortSignal.timeout` fired: a `TimeoutError`, not an `HttpError`.
    #[error("TimeoutError: The operation was aborted due to timeout")]
    Timeout,
    /// `fetch` rejected (no route, refused, TLS, reset): `TypeError: fetch failed`.
    #[error("TypeError: fetch failed ({0})")]
    Network(String),
    /// `res.json()` threw on a 2xx body that is not JSON: an unwrapped `SyntaxError`.
    #[error("SyntaxError: {0}")]
    Syntax(String),
    /// The body parsed but is not the shape this port needs (TypeScript casts
    /// and finds out later; a strict parse cannot).
    #[error("ShapeError: {0}")]
    Shape(String),
    /// `RangeError: Invalid time value` from `toISOString`.
    #[error("RangeError: Invalid time value")]
    InvalidTime,
    /// Anything else that threw: the message of the `Error` (e.g. `openExternal`).
    #[error("{0}")]
    Other(String),
    /// The token store failed (its raw error propagates in TypeScript).
    #[error("{0}")]
    Token(String),
}

impl ApiError {
    /// `err.message`, which `uploader.ts::errText` reads.
    #[must_use]
    pub fn message(&self) -> String {
        match self {
            Self::Unauthorized(m)
            | Self::Syntax(m)
            | Self::Shape(m)
            | Self::Token(m)
            | Self::Other(m) => m.clone(),
            Self::Http { path, status, body } => format!("{path} {status}: {body}"),
            Self::Timeout => "The operation was aborted due to timeout".to_owned(),
            Self::Network(_) => "fetch failed".to_owned(),
            Self::InvalidTime => "Invalid time value".to_owned(),
        }
    }

    /// `err instanceof UnauthorizedError`.
    #[must_use]
    pub const fn is_unauthorized(&self) -> bool {
        matches!(self, Self::Unauthorized(_))
    }

    /// `err instanceof HttpError && err.status === status`.
    #[must_use]
    pub const fn is_http_status(&self, wanted: u16) -> bool {
        matches!(self, Self::Http { status, .. } if *status == wanted)
    }
}

impl From<TokenError> for ApiError {
    fn from(err: TokenError) -> Self {
        Self::Token(err.to_string())
    }
}

impl From<timo_core::js::iso::InvalidTimeValue> for ApiError {
    fn from(_: timo_core::js::iso::InvalidTimeValue) -> Self {
        Self::InvalidTime
    }
}
