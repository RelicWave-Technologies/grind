//! `TimeZoneSchema` and the small helpers that live beside it.

use super::zone::is_valid_time_zone;

/// Port of `packages/types/src/timezone.ts::DEFAULT_TIME_ZONE`.
pub const DEFAULT_TIME_ZONE: &str = "UTC";

/// `String.prototype.trim`'s set: `WhiteSpace` and `LineTerminator`. Not the same as
/// `char::is_whitespace` (that adds U+0085 and misses U+FEFF).
const fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// JavaScript `String.prototype.trim`.
#[must_use]
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

/// JavaScript `String.prototype.trimStart` (what `parseInt` skips first).
#[must_use]
pub fn js_trim_start(text: &str) -> &str {
    text.trim_start_matches(is_js_space)
}

/// Port of `packages/types/src/timezone.ts::TimeZoneSchema` (`safeParse`).
///
/// `z.string().trim().min(1).max(80).refine(isValidTimeZone)`: the string is
/// trimmed first, then must be 1..=80 UTF-16 code units, then must be a zone
/// `Intl` accepts. Returns the trimmed value (what `.data` holds), `None` on
/// any failure.
#[must_use]
pub fn parse_time_zone(value: &str) -> Option<String> {
    let trimmed = js_trim(value);
    let units = trimmed.encode_utf16().count();
    ((1..=80).contains(&units) && is_valid_time_zone(trimmed)).then(|| trimmed.to_owned())
}
