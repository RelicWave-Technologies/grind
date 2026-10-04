//! Version parsing and comparison of `updates/state.ts`.

use crate::js::number::strict_eq;

#[derive(Debug)]
struct ParsedVersion<'a> {
    major: f64,
    minor: f64,
    patch: f64,
    prerelease: Vec<&'a str>,
}

/// `/^\d+/`-style run of ASCII digits at the start of `s`.
fn digits(s: &str) -> Option<(&str, &str)> {
    let end = s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len());
    if end == 0 {
        return None;
    }
    s.split_at_checked(end)
}

/// `Number(digits)`.
fn number(digits: &str) -> f64 {
    digits.parse::<f64>().unwrap_or(f64::NAN)
}

/// `/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u`.
fn parse_version(version: &str) -> Option<ParsedVersion<'_>> {
    let rest = version.strip_prefix('v').unwrap_or(version);
    let (major, rest) = digits(rest)?;
    let rest = rest.strip_prefix('.')?;
    let (minor, rest) = digits(rest)?;
    let rest = rest.strip_prefix('.')?;
    let (patch, rest) = digits(rest)?;
    let prerelease = if rest.is_empty() {
        Vec::new()
    } else {
        let tag = rest.strip_prefix('-')?;
        let ok = !tag.is_empty()
            && tag
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
        if !ok {
            return None;
        }
        tag.split('.').collect()
    };
    Some(ParsedVersion {
        major: number(major),
        minor: number(minor),
        patch: number(patch),
        prerelease,
    })
}

/// `/^\d+$/u.test(s)`.
fn is_numeric(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_digit())
}

/// `comparePrerelease(a, b)`: `-1`, `0` or `1`.
fn compare_prerelease(a: &[&str], b: &[&str]) -> i32 {
    if a.is_empty() && b.is_empty() {
        return 0;
    }
    if a.is_empty() {
        return 1;
    }
    if b.is_empty() {
        return -1;
    }
    let longest = a.len().max(b.len());
    for i in 0..longest {
        let (Some(ai), Some(bi)) = (a.get(i), b.get(i)) else {
            // `ai == null` first: a ran out before b.
            return if a.get(i).is_none() { -1 } else { 1 };
        };
        let an = is_numeric(ai).then(|| number(ai));
        let bn = is_numeric(bi).then(|| number(bi));
        if let (Some(x), Some(y)) = (an, bn)
            && !strict_eq(x, y)
        {
            return if x > y { 1 } else { -1 };
        }
        if an.is_some() && bn.is_none() {
            return -1;
        }
        if an.is_none() && bn.is_some() {
            return 1;
        }
        if an.is_none() && bn.is_none() && ai != bi {
            return if ai > bi { 1 } else { -1 };
        }
    }
    0
}

/// Port of `compareVersions`: `None` when either side does not parse.
#[must_use]
pub fn compare_versions(a: &str, b: &str) -> Option<i32> {
    let av = parse_version(a)?;
    let bv = parse_version(b)?;
    for (x, y) in [
        (av.major, bv.major),
        (av.minor, bv.minor),
        (av.patch, bv.patch),
    ] {
        if !strict_eq(x, y) {
            return Some(if x > y { 1 } else { -1 });
        }
    }
    Some(compare_prerelease(&av.prerelease, &bv.prerelease))
}

/// Port of `isVersionNewer`.
#[must_use]
pub fn is_version_newer(current_version: &str, candidate_version: Option<&str>) -> bool {
    let Some(candidate) = candidate_version.filter(|c| !c.is_empty()) else {
        return false;
    };
    compare_versions(candidate, current_version)
        .map_or(candidate != current_version, |compared| compared > 0)
}
