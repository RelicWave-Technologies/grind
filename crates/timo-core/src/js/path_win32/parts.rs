//! `path.win32.basename`, `dirname` and `join`.

use super::normalize::normalize;
use super::{BACKSLASH, COLON, at, is_device_root, is_sep, skip, slice, text, units};

/// `path.win32.basename(path)` (no suffix).
#[must_use]
pub fn basename(path: &str) -> String {
    let path = units(path);
    let mut start = 0;
    if path.len() >= 2 && is_device_root(at(&path, 0)) && at(&path, 1) == COLON {
        start = 2;
    }
    let mut end: Option<usize> = None;
    let mut matched_slash = true;
    for i in (start..path.len()).rev() {
        if is_sep(at(&path, i)) {
            if !matched_slash {
                start = i + 1;
                break;
            }
        } else if end.is_none() {
            matched_slash = false;
            end = Some(i + 1);
        }
    }
    end.map_or_else(String::new, |e| text(slice(&path, start, e)))
}

/// `path.win32.dirname(path)`.
#[must_use]
pub fn dirname(path: &str) -> String {
    let path = units(path);
    let len = path.len();
    if len == 0 {
        return ".".to_owned();
    }
    let code = at(&path, 0);
    if len == 1 {
        return if is_sep(code) {
            text(&path)
        } else {
            ".".to_owned()
        };
    }
    let (root_end, offset) = match dirname_root(&path) {
        Ok(found) => found,
        Err(whole) => return whole,
    };
    let mut end: Option<usize> = None;
    let mut matched_slash = true;
    for i in (offset..len).rev() {
        if is_sep(at(&path, i)) {
            if !matched_slash {
                end = Some(i);
                break;
            }
        } else {
            matched_slash = false;
        }
    }
    let end = match (end, root_end) {
        (Some(e), _) => e,
        (None, None) => return ".".to_owned(),
        (None, Some(r)) => r,
    };
    text(slice(&path, 0, end))
}

/// `(rootEnd, offset)` for `dirname`; `Err(path)` when the whole path is a UNC
/// root and is returned as is.
fn dirname_root(path: &[u16]) -> Result<(Option<usize>, usize), String> {
    let len = path.len();
    let code = at(path, 0);
    if is_sep(code) {
        let mut root_end = 1;
        let mut offset = 1;
        if is_sep(at(path, 1)) {
            let mut j = skip(path, 2, |c| !is_sep(c));
            let mut last = 2;
            if j < len && j != last {
                last = j;
                j = skip(path, j, is_sep);
                if j < len && j != last {
                    last = j;
                    j = skip(path, j, |c| !is_sep(c));
                    if j == len {
                        return Err(text(path));
                    }
                    if j != last {
                        root_end = j + 1;
                        offset = j + 1;
                    }
                }
            }
        }
        return Ok((Some(root_end), offset));
    }
    if is_device_root(code) && at(path, 1) == COLON {
        let root_end = if len > 2 && is_sep(at(path, 2)) { 3 } else { 2 };
        return Ok((Some(root_end), root_end));
    }
    Ok((None, 0))
}

/// `path.win32.join(...paths)`.
#[must_use]
pub fn join(paths: &[&str]) -> String {
    let mut joined: Option<Vec<u16>> = None;
    let mut first_part: Vec<u16> = Vec::new();
    for arg in paths {
        let arg = units(arg);
        if arg.is_empty() {
            continue;
        }
        match joined.as_mut() {
            None => {
                first_part.clone_from(&arg);
                joined = Some(arg);
            }
            Some(j) => {
                j.push(BACKSLASH);
                j.extend(arg);
            }
        }
    }
    let Some(mut joined) = joined else {
        return ".".to_owned();
    };
    let mut needs_replace = true;
    let mut slash_count = 0;
    if is_sep(at(&first_part, 0)) {
        slash_count += 1;
        let first_len = first_part.len();
        if first_len > 1 && is_sep(at(&first_part, 1)) {
            slash_count += 1;
            if first_len > 2 {
                if is_sep(at(&first_part, 2)) {
                    slash_count += 1;
                } else {
                    // A UNC path in the first part.
                    needs_replace = false;
                }
            }
        }
    }
    if needs_replace {
        slash_count = skip(&joined, slash_count, is_sep);
        if slash_count >= 2 {
            let mut out = vec![BACKSLASH];
            out.extend_from_slice(slice(&joined, slash_count, joined.len()));
            joined = out;
        }
    }
    normalize(&text(&joined))
}
