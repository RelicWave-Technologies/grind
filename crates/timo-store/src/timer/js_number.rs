//! `Number(text)` and `Number.isInteger`, for the values read back from SQLite
//! and JSON.

use timo_core::js::number::strict_eq;

/// `Number(text)` for the strings this store writes (`String(ts)`), plus the
/// JavaScript spellings a hand-edited row could hold. `NaN` when it is not a
/// number. Only finite results matter to the callers.
#[must_use]
pub fn number_from_string(text: &str) -> f64 {
    let trimmed = text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if trimmed.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = trimmed.strip_prefix(prefix) {
            return u64::from_str_radix(digits, radix)
                .ok()
                .and_then(|n| timo_core::js::number::i64_to_f64(i64::try_from(n).ok()?).ok())
                .unwrap_or(f64::NAN);
        }
    }
    match trimmed {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    // Rust also accepts "inf", "nan" and "1_0"-style spellings JavaScript rejects.
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_digit() || "+-.eE".contains(c))
    {
        return f64::NAN;
    }
    trimmed.parse::<f64>().unwrap_or(f64::NAN)
}

/// `typeof value === 'number' && Number.isInteger(value) && value >= 0`.
#[must_use]
pub fn is_non_negative_integer(value: f64) -> bool {
    value.is_finite() && strict_eq(value.trunc(), value) && value >= 0.0
}
