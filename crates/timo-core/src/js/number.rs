//! JavaScript `Number` and `Math` semantics.
//!
//! Every timestamp in the agent is a JavaScript number, and a real one is
//! fractional (`1791133383891.2627`: the timer clock is
//! `anchorServer + (performance.now() - anchorMono)`). So times are `f64` here
//! and arithmetic is done on doubles in the order the TypeScript writes it:
//! floating-point addition is not associative, and a different order is a
//! different number of milliseconds.
//!
//! Operators the TypeScript uses (`+`, `-`) go through [`add`] and [`sub`], and
//! `===` through [`strict_eq`], so this module is the only one with float
//! arithmetic and exact float comparison.
#![allow(
    clippy::float_arithmetic,
    clippy::float_cmp,
    clippy::as_conversions,
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    reason = "this module is the one place that implements JavaScript's f64 \
              semantics; every conversion is range-checked and every float \
              comparison is an exact IEEE comparison on purpose"
)]

use core::cmp::Ordering;

use thiserror::Error;

/// 2^63 as a double (exactly representable).
const TWO_POW_63: f64 = 9_223_372_036_854_775_808.0;
/// 2^52: from here up every double is an integer.
const TWO_POW_52: f64 = 4_503_599_627_370_496.0;

/// A conversion that JavaScript could not have performed exactly.
#[derive(Debug, Clone, PartialEq, Error)]
pub enum NumberError {
    /// An `i64` that no double represents exactly.
    #[error("{0} is not exactly representable as a JavaScript number")]
    NotRepresentable(i64),
    /// A double that is not an integer inside the `i64` range.
    #[error("{0} is not an integer inside the i64 range")]
    NotAnInteger(f64),
}

/// Exact `i64` to double. Errors when the double would be a different integer.
pub fn i64_to_f64(n: i64) -> Result<f64, NumberError> {
    let f = n as f64;
    if f < TWO_POW_63 && f as i64 == n {
        Ok(f)
    } else {
        Err(NumberError::NotRepresentable(n))
    }
}

/// Exact double to `i64`. Errors on NaN, infinities, fractions and overflow;
/// `-0` becomes `0`.
pub fn f64_to_i64(x: f64) -> Result<i64, NumberError> {
    if x.is_finite() && x.trunc() == x && (-TWO_POW_63..TWO_POW_63).contains(&x) {
        Ok(x as i64)
    } else {
        Err(NumberError::NotAnInteger(x))
    }
}

/// JavaScript `a + b`.
#[must_use]
pub fn add(a: f64, b: f64) -> f64 {
    a + b
}

/// JavaScript `a - b`.
#[must_use]
pub fn sub(a: f64, b: f64) -> f64 {
    a - b
}

/// JavaScript `a === b` on numbers: `NaN` is unequal to itself, `-0 === 0`.
#[must_use]
pub fn strict_eq(a: f64, b: f64) -> bool {
    a == b
}

/// The result of the sort comparator `(a, b) => a - b || tiebreak`: the sign
/// of `a - b`, or `Equal` when the difference is `0` or `NaN` (both falsy, so
/// the tiebreak runs).
#[must_use]
pub fn sort_cmp(a: f64, b: f64) -> Ordering {
    let diff = a - b;
    if diff > 0.0 {
        Ordering::Greater
    } else if diff < 0.0 {
        Ordering::Less
    } else {
        Ordering::Equal
    }
}

/// `Math.max(a, b)`: NaN if either is NaN, and `+0` beats `-0`.
#[must_use]
pub fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_negative() { b } else { a }
    } else if a > b {
        a
    } else {
        b
    }
}

/// `Math.min(a, b)`: NaN if either is NaN, and `-0` beats `+0`.
#[must_use]
pub fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_negative() { a } else { b }
    } else if a < b {
        a
    } else {
        b
    }
}

/// `Math.round(x)`: halves go towards +Infinity (`Math.round(-33.5) === -33`,
/// where `f64::round` gives -34), and `-0.4` rounds to `-0`.
#[must_use]
pub fn round(x: f64) -> f64 {
    if !x.is_finite() || x == 0.0 || x.abs() >= TWO_POW_52 {
        return x;
    }
    let below = x.floor();
    let rounded = if x - below >= 0.5 { below + 1.0 } else { below };
    if rounded == 0.0 && x < 0.0 {
        -0.0
    } else {
        rounded
    }
}

/// `Math.floor(x)`.
#[must_use]
pub fn floor(x: f64) -> f64 {
    x.floor()
}

/// `Math.ceil(x)`.
#[must_use]
pub fn ceil(x: f64) -> f64 {
    x.ceil()
}

/// `Math.trunc(x)`.
#[must_use]
pub fn trunc(x: f64) -> f64 {
    x.trunc()
}

/// JavaScript `a % b` on doubles: the remainder keeps the dividend's sign, and
/// a zero divisor or infinite dividend gives NaN.
#[must_use]
pub fn rem(a: f64, b: f64) -> f64 {
    a % b
}

/// `Number.prototype.toString()` (radix 10), which is also what a template
/// literal and `JSON.stringify` (for finite values) write: shortest digits that
/// round-trip, `5` not `5.0`, `-0` as `0`, exponent form from 1e21 and below
/// 1e-6. Delegates to `ryu-js`, the crate Boa uses for the same purpose.
#[must_use]
pub fn number_to_string(x: f64) -> String {
    ryu_js::Buffer::new().format(x).to_owned()
}
