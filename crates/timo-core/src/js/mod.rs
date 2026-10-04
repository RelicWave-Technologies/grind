//! JavaScript semantics, spelled out.
//!
//! The TypeScript original runs on V8, so every number is an IEEE double,
//! `Math.round` rounds halves towards +Infinity, `Array.prototype.sort` is
//! stable, `localeCompare` is ICU collation and `new Date(string)` is V8's date
//! parser. Rust's defaults differ in each case (`f64::round` rounds halves away
//! from zero, `str::cmp` is code-point order). Everything the ported code needs
//! from JavaScript lives here, behind one name per behaviour, and is held to
//! golden output from the real engine (`tests/fixtures/js/`).
pub mod collate;
pub mod date;
pub mod json;
pub mod number;
pub mod ser;
