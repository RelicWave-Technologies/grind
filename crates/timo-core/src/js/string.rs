//! JavaScript `String.prototype` behaviour that Rust's `str` differs on.

/// The characters `String.prototype.trim` strips: ECMAScript `WhiteSpace` and
/// `LineTerminator` (tab, VT, FF, space, NBSP, ZWNBSP/BOM, the `Zs` category,
/// LF, CR, LS, PS). Rust's `str::trim` uses Unicode `White_Space`, which also
/// strips U+0085 and does not strip U+FEFF.
#[must_use]
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// `s.trim()`.
#[must_use]
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}
