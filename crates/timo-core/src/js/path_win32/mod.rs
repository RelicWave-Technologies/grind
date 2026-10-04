//! Node's `path.win32`: `normalize`, `basename`, `dirname` and `join`.
//!
//! The Windows launch-item logic compares paths with these, so they follow
//! Node's `lib/path.js` step for step. Indices are UTF-16 code units, like the
//! JavaScript; every cut falls on an ASCII separator, so a surrogate pair is
//! never split. `normalize` includes the CVE-2024-36139 colon guard of current
//! Node (see `PARITY.md` for the Node version the fixtures were dumped from).

const BACKSLASH: u16 = 92;
const SLASH: u16 = 47;
const DOT: u16 = 46;
const COLON: u16 = 58;

fn units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

/// UTF-16 back to a string. Every cut is at an ASCII separator, so no pair is
/// ever split and nothing is lost.
fn text(u: &[u16]) -> String {
    String::from_utf16_lossy(u)
}

fn is_sep(c: u16) -> bool {
    c == BACKSLASH || c == SLASH
}

fn is_device_root(c: u16) -> bool {
    (65..=90).contains(&c) || (97..=122).contains(&c)
}

/// `path.charCodeAt(i)`; `0` stands in for `NaN` past the end (no separator,
/// no dot, no colon).
fn at(u: &[u16], i: usize) -> u16 {
    u.get(i).copied().unwrap_or(0)
}

/// `path.slice(from, to)` for in-range, ordered bounds.
fn slice(u: &[u16], from: usize, to: usize) -> &[u16] {
    u.get(from..to.min(u.len())).unwrap_or_default()
}

fn last_index_of(u: &[u16], c: u16) -> Option<usize> {
    u.iter().rposition(|x| *x == c)
}

/// Skip `pred` characters from `j`.
fn skip(path: &[u16], mut j: usize, pred: impl Fn(u16) -> bool) -> usize {
    while j < path.len() && pred(at(path, j)) {
        j += 1;
    }
    j
}

mod normalize;
mod parts;

pub use normalize::normalize;
pub use parts::{basename, dirname, join};
