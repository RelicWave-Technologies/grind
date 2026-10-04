//! How JavaScript sees a column.
//!
//! better-sqlite3 hands the TypeScript stores a JS `number` for both INTEGER and
//! REAL storage (never a `BigInt` unless asked), and the stores then wrap each
//! column in `Number(...)` / `String(...)`. These helpers do the same to a
//! SQLite value, so a row mapped here is the row `map()` produces there, even
//! when a column holds something its declared affinity would not normally allow
//! (an old install, a hand-edited database).

use rusqlite::types::{FromSql, ValueRef};
use rusqlite::{Result, Row};
use timo_core::js::math::neg;
use timo_core::js::number::number_to_string;

/// The double JS holds for an INTEGER or REAL value.
fn numeric(value: ValueRef<'_>) -> f64 {
    f64::column_result(value).unwrap_or(f64::NAN)
}

/// `Number(x)` for a column value. `Number(null)` is `0`; text is read as a
/// decimal literal (`Number("12.5")`), anything else is `NaN`. Hex, octal and
/// binary text literals (`Number("0x10")`) are not reproduced: no store here
/// ever writes text into a numeric column.
pub(crate) fn js_number(value: ValueRef<'_>) -> f64 {
    match value {
        ValueRef::Null => 0.0,
        ValueRef::Integer(_) | ValueRef::Real(_) => numeric(value),
        ValueRef::Text(bytes) => text_to_number(&String::from_utf8_lossy(bytes)),
        ValueRef::Blob(_) => f64::NAN,
    }
}

/// `String(x)` for a column value.
pub(crate) fn js_string(value: ValueRef<'_>) -> String {
    match value {
        ValueRef::Null => "null".to_owned(),
        ValueRef::Integer(_) | ValueRef::Real(_) => number_to_string(numeric(value)),
        ValueRef::Text(bytes) | ValueRef::Blob(bytes) => {
            String::from_utf8_lossy(bytes).into_owned()
        }
    }
}

/// `x === null ? null : String(x)`.
pub(crate) fn opt_string(value: ValueRef<'_>) -> Option<String> {
    (value != ValueRef::Null).then(|| js_string(value))
}

/// `x === null ? null : Number(x)`.
pub(crate) fn opt_number(value: ValueRef<'_>) -> Option<f64> {
    (value != ValueRef::Null).then(|| js_number(value))
}

/// `Number(row.<name>)`.
pub(crate) fn number_at(row: &Row<'_>, name: &str) -> Result<f64> {
    Ok(js_number(row.get_ref(name)?))
}

/// `String(row.<name>)`.
pub(crate) fn string_at(row: &Row<'_>, name: &str) -> Result<String> {
    Ok(js_string(row.get_ref(name)?))
}

/// `row.<name> === null ? null : String(row.<name>)`.
pub(crate) fn opt_string_at(row: &Row<'_>, name: &str) -> Result<Option<String>> {
    Ok(opt_string(row.get_ref(name)?))
}

/// `row.<name> === null ? null : Number(row.<name>)`.
pub(crate) fn opt_number_at(row: &Row<'_>, name: &str) -> Result<Option<f64>> {
    Ok(opt_number(row.get_ref(name)?))
}

/// The whitespace `String.prototype.trim` removes (`WhiteSpace` + `LineTerminator`).
pub(crate) fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{9}'
            | '\u{a}'
            | '\u{b}'
            | '\u{c}'
            | '\u{d}'
            | '\u{20}'
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `Number(text)` for a decimal literal; `NaN` otherwise. `Number("")` is `0`.
fn text_to_number(text: &str) -> f64 {
    let trimmed = text.trim_matches(is_js_whitespace);
    if trimmed.is_empty() {
        return 0.0;
    }
    let (negative, body) = match trimmed.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    let magnitude = if body == "Infinity" {
        f64::INFINITY
    } else if is_decimal_literal(body) {
        body.parse::<f64>().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    };
    if negative { neg(magnitude) } else { magnitude }
}

/// `digits [. digits] [e [+-] digits]` or `. digits [...]`, at least one mantissa digit.
fn is_decimal_literal(body: &str) -> bool {
    let (mantissa, exponent) = match body.split_once(['e', 'E']) {
        Some((m, e)) => (m, Some(e)),
        None => (body, None),
    };
    let (int_part, frac_part) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    let mantissa_ok =
        digits(int_part) && digits(frac_part) && !(int_part.is_empty() && frac_part.is_empty());
    let exponent_ok = exponent.is_none_or(|e| {
        let unsigned = e.strip_prefix(['+', '-']).unwrap_or(e);
        !unsigned.is_empty() && digits(unsigned)
    });
    mantissa_ok && exponent_ok
}

#[cfg(test)]
#[allow(
    clippy::float_cmp,
    reason = "the literals compared are exact doubles Number() must produce"
)]
mod tests {
    use super::*;

    #[test]
    fn reads_numbers_the_way_number_does() {
        assert_eq!(text_to_number("12.5"), 12.5);
        assert_eq!(text_to_number("  -3e2 "), -300.0);
        assert_eq!(text_to_number(""), 0.0);
        assert_eq!(text_to_number(".5"), 0.5);
        assert_eq!(text_to_number("5."), 5.0);
        assert_eq!(text_to_number("-Infinity"), f64::NEG_INFINITY);
        assert!(text_to_number("abc").is_nan());
        assert!(text_to_number("1e").is_nan());
        assert!(text_to_number(".").is_nan());
        assert!(text_to_number("inf").is_nan());
    }
}
