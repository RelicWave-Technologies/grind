//! Bytes on the wire: `JSON.stringify` and `Date.prototype.toISOString`.

use serde::Serialize;
use timo_core::js::iso::to_iso_string;
use timo_core::js::ser::to_string;

use crate::error::ApiError;

/// `JSON.stringify(value)`: whole numbers without `.0`, declaration key order.
pub fn json_body<T: Serialize + ?Sized>(value: &T) -> Result<String, ApiError> {
    to_string(value).map_err(|e| ApiError::Shape(e.to_string()))
}

/// `new Date(ms).toISOString()`: fractional milliseconds are truncated.
pub fn iso(ms: f64) -> Result<String, ApiError> {
    Ok(to_iso_string(ms)?)
}
