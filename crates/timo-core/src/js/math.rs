//! More of JavaScript's `Number` operators and `Math`, for the activity and
//! prompt services: `*`, `/`, `Math.sqrt`, `x ** 2` and `Math.hypot`.
//!
//! Like [`super::number`], this module is allowed float arithmetic so that the
//! ported code can spell every operation as a named call in the TypeScript's
//! own order. `Math.hypot` is V8's algorithm (a scaled, Kahan-compensated sum of
//! squares), not the libm `hypot`: libms differ in the last bit and the last bit
//! of a mouse distance is what gets rounded into a stored sample.
#![allow(
    clippy::float_arithmetic,
    clippy::float_cmp,
    clippy::as_conversions,
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    reason = "this module implements JavaScript's f64 semantics; every float \
              comparison is an exact IEEE comparison on purpose"
)]

/// JavaScript `a * b`.
#[must_use]
pub fn mul(a: f64, b: f64) -> f64 {
    a * b
}

/// JavaScript `a / b`.
#[must_use]
pub fn div(a: f64, b: f64) -> f64 {
    a / b
}

/// JavaScript `-a` (so `neg(0)` is `-0`).
#[must_use]
pub fn neg(a: f64) -> f64 {
    -a
}

/// `Math.sqrt(x)` (IEEE square root, correctly rounded in V8 and Rust).
#[must_use]
pub fn sqrt(x: f64) -> f64 {
    x.sqrt()
}

/// `x ** 2`. V8 evaluates it as `x * x` (checked bit for bit over 20 million
/// doubles, see `PARITY.md`).
#[must_use]
pub fn square(x: f64) -> f64 {
    x * x
}

/// `Math.abs(x)`.
#[must_use]
pub fn abs(x: f64) -> f64 {
    x.abs()
}

/// `array.length` as a JavaScript number. Lengths here are in memory, so far
/// below 2^53 and exactly representable.
#[must_use]
pub fn len_f64(len: usize) -> f64 {
    len as f64
}

/// `Math.hypot(...values)`: V8's `MathHypot`. Infinity wins over NaN, NaN over
/// the rest; all zeros give `0`; otherwise `sqrt(sum((|v| / max)^2)) * max`
/// with Kahan summation.
#[must_use]
pub fn hypot(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut max = 0.0_f64;
    let mut any_nan = false;
    for v in values {
        if v.is_nan() {
            any_nan = true;
        } else if v.abs() > max {
            max = v.abs();
        }
    }
    if max == f64::INFINITY {
        return f64::INFINITY;
    }
    if any_nan {
        return f64::NAN;
    }
    if max == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0_f64;
    let mut compensation = 0.0_f64;
    for v in values {
        // A NaN never reaches here (returned above), so `abs` is the stored value.
        let n = v.abs() / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
}

/// `Math.hypot(a, b)`.
#[must_use]
pub fn hypot2(a: f64, b: f64) -> f64 {
    hypot(&[a, b])
}
