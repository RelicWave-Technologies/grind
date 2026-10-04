//! `path.win32.normalize`.

use super::{
    BACKSLASH, COLON, DOT, SLASH, at, is_device_root, is_sep, last_index_of, skip, slice, text,
    units,
};

/// `res.length - 1 - res.lastIndexOf('\\')`: the length of the last segment.
fn segment_len(res: &[u16]) -> usize {
    match last_index_of(res, BACKSLASH) {
        Some(p) => res.len().saturating_sub(1).saturating_sub(p),
        None => res.len(),
    }
}

/// The state `normalizeString` threads through its loop.
struct Walk {
    res: Vec<u16>,
    last_segment_length: usize,
    last_slash: i64,
    dots: i64,
}

impl Walk {
    /// The `dots === 2` case (a `..` segment ended).
    fn dot_dot(&mut self, allow_above_root: bool) {
        let tail_is_dot_dot = self.res.len() >= 2
            && self.last_segment_length == 2
            && at(&self.res, self.res.len() - 1) == DOT
            && at(&self.res, self.res.len() - 2) == DOT;
        if !tail_is_dot_dot {
            if self.res.len() > 2 {
                match last_index_of(&self.res, BACKSLASH) {
                    None => {
                        self.res.clear();
                        self.last_segment_length = 0;
                    }
                    Some(cut) => {
                        self.res.truncate(cut);
                        self.last_segment_length = segment_len(&self.res);
                    }
                }
                return;
            }
            if !self.res.is_empty() {
                self.res.clear();
                self.last_segment_length = 0;
                return;
            }
        }
        if allow_above_root {
            if !self.res.is_empty() {
                self.res.push(BACKSLASH);
            }
            self.res.extend([DOT, DOT]);
            self.last_segment_length = 2;
        }
    }

    /// A separator at index `i`: close the segment that just ended.
    fn separator(&mut self, path: &[u16], i: usize, allow_above_root: bool) {
        let ii = i64::try_from(i).unwrap_or(i64::MAX);
        if self.last_slash == ii - 1 || self.dots == 1 {
            // NOOP
        } else if self.dots == 2 {
            self.dot_dot(allow_above_root);
        } else {
            let from = usize::try_from(self.last_slash + 1).unwrap_or(0);
            if !self.res.is_empty() {
                self.res.push(BACKSLASH);
            }
            self.res.extend_from_slice(slice(path, from, i));
            self.last_segment_length = i.saturating_sub(from);
        }
        self.last_slash = ii;
        self.dots = 0;
    }
}

/// `normalizeString(path, allowAboveRoot, '\\', isPathSeparator)`.
fn normalize_string(path: &[u16], allow_above_root: bool) -> Vec<u16> {
    let mut walk = Walk {
        res: Vec::new(),
        last_segment_length: 0,
        last_slash: -1,
        dots: 0,
    };
    let mut code: u16 = 0;
    for i in 0..=path.len() {
        if i < path.len() {
            code = at(path, i);
        } else if is_sep(code) {
            break;
        } else {
            code = SLASH;
        }
        if is_sep(code) {
            walk.separator(path, i, allow_above_root);
        } else if code == DOT && walk.dots != -1 {
            walk.dots += 1;
        } else {
            walk.dots = -1;
        }
    }
    walk.res
}

/// What the root matching of `normalize` found.
struct Root {
    device: Option<Vec<u16>>,
    /// Where the root ends (`rootEnd`).
    end: usize,
    is_absolute: bool,
    /// A complete answer: the path was only a UNC root.
    done: Option<Vec<u16>>,
}

/// The UNC branch of `normalize`: `path` starts with two separators.
fn match_unc(path: &[u16]) -> Root {
    let len = path.len();
    let mut root = Root {
        device: None,
        end: 0,
        is_absolute: true,
        done: None,
    };
    let mut j = skip(path, 2, |c| !is_sep(c));
    let mut last = 2;
    if j < len && j != last {
        let first_part = slice(path, last, j);
        last = j;
        j = skip(path, j, is_sep);
        if j < len && j != last {
            last = j;
            j = skip(path, j, |c| !is_sep(c));
            if j == len {
                let mut out = vec![BACKSLASH, BACKSLASH];
                out.extend_from_slice(first_part);
                out.push(BACKSLASH);
                out.extend_from_slice(slice(path, last, len));
                out.push(BACKSLASH);
                root.done = Some(out);
            } else if j != last {
                let mut device = vec![BACKSLASH, BACKSLASH];
                device.extend_from_slice(first_part);
                device.push(BACKSLASH);
                device.extend_from_slice(slice(path, last, j));
                root.device = Some(device);
                root.end = j;
            }
        }
    }
    root
}

fn match_root(path: &[u16]) -> Root {
    let code = at(path, 0);
    if is_sep(code) {
        if is_sep(at(path, 1)) {
            return match_unc(path);
        }
        return Root {
            device: None,
            end: 1,
            is_absolute: true,
            done: None,
        };
    }
    let mut root = Root {
        device: None,
        end: 0,
        is_absolute: false,
        done: None,
    };
    if is_device_root(code) && at(path, 1) == COLON {
        root.device = Some(slice(path, 0, 2).to_vec());
        root.end = 2;
        if path.len() > 2 && is_sep(at(path, 2)) {
            root.is_absolute = true;
            root.end = 3;
        }
    }
    root
}

/// The CVE-2024-36139 guard: a relative, device-less path that still contains a
/// colon must not turn into something Windows reads as a drive.
fn colon_guard(path: &[u16], tail: &[u16]) -> Option<Vec<u16>> {
    if !path.contains(&COLON) {
        return None;
    }
    let guarded = || {
        let mut out = vec![DOT, BACKSLASH];
        out.extend_from_slice(tail);
        Some(out)
    };
    if tail.len() >= 2 && is_device_root(at(tail, 0)) && at(tail, 1) == COLON {
        return guarded();
    }
    let len = path.len();
    let mut from = 0;
    while let Some(offset) = path
        .get(from..)
        .and_then(|rest| rest.iter().position(|c| *c == COLON))
    {
        let index = from + offset;
        if index == len - 1 || is_sep(at(path, index + 1)) {
            return guarded();
        }
        from = index + 1;
    }
    None
}

/// `path.win32.normalize(path)`.
#[must_use]
pub fn normalize(path: &str) -> String {
    let path = units(path);
    text(&normalize_units(&path))
}

fn normalize_units(path: &[u16]) -> Vec<u16> {
    let len = path.len();
    if len == 0 {
        return vec![DOT];
    }
    if len == 1 {
        return if at(path, 0) == SLASH {
            vec![BACKSLASH]
        } else {
            path.to_vec()
        };
    }
    let root = match_root(path);
    if let Some(done) = root.done {
        return done;
    }
    let mut tail = if root.end < len {
        normalize_string(slice(path, root.end, len), !root.is_absolute)
    } else {
        Vec::new()
    };
    if tail.is_empty() && !root.is_absolute {
        tail = vec![DOT];
    }
    if !tail.is_empty() && is_sep(at(path, len - 1)) {
        tail.push(BACKSLASH);
    }
    if !root.is_absolute
        && root.device.is_none()
        && let Some(guarded) = colon_guard(path, &tail)
    {
        return guarded;
    }
    match (root.device, root.is_absolute) {
        (None, true) => [&[BACKSLASH][..], &tail].concat(),
        (None, false) => tail,
        (Some(device), true) => [&device[..], &[BACKSLASH][..], &tail].concat(),
        (Some(device), false) => [&device[..], &tail].concat(),
    }
}
