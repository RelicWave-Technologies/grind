//! A `TZif` (RFC 8536) reader: just enough to answer "what is the UTC offset at
//! this instant" for the zone files `jiff-tzdb` embeds.
//!
//! The 64-bit block is used. An instant before the first transition gets local
//! time type 0 (the zone's LMT, which ICU also uses); one at or after the last
//! transition gets the footer's POSIX rule, which is how the "slim" files in
//! `jiff-tzdb` carry every year after the last explicit change.

use super::posix::PosixRule;

/// A parsed zone file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TzData {
    times: Vec<i64>,
    kinds: Vec<u8>,
    offsets: Vec<i64>,
    footer: Option<PosixRule>,
}

/// A cursor over the file's bytes; every read is bounds-checked.
struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let end = self.pos.checked_add(n)?;
        let bytes = self.data.get(self.pos..end)?;
        self.pos = end;
        Some(bytes)
    }

    fn be_u32(&mut self) -> Option<u32> {
        Some(u32::from_be_bytes(self.take(4)?.try_into().ok()?))
    }

    fn be_i32(&mut self) -> Option<i32> {
        Some(i32::from_be_bytes(self.take(4)?.try_into().ok()?))
    }

    fn be_i64(&mut self) -> Option<i64> {
        Some(i64::from_be_bytes(self.take(8)?.try_into().ok()?))
    }

    fn count(&mut self) -> Option<usize> {
        usize::try_from(self.be_u32()?).ok()
    }
}

/// The six counts of a header, in file order.
struct Counts {
    isut: usize,
    isstd: usize,
    leap: usize,
    time: usize,
    kind: usize,
    chars: usize,
}

fn header(r: &mut Reader<'_>) -> Option<(u8, Counts)> {
    if r.take(4)? != b"TZif" {
        return None;
    }
    let version = *r.take(1)?.first()?;
    r.take(15)?;
    let counts = Counts {
        isut: r.count()?,
        isstd: r.count()?,
        leap: r.count()?,
        time: r.count()?,
        kind: r.count()?,
        chars: r.count()?,
    };
    Some((version, counts))
}

/// Skip the whole 32-bit block of a version 2+ file.
fn skip_v1(r: &mut Reader<'_>, c: &Counts) -> Option<()> {
    let size = c.time * 5 + c.kind * 6 + c.chars + c.leap * 8 + c.isstd + c.isut;
    r.take(size).map(|_| ())
}

/// The data of one block (64-bit times) and the footer that follows it.
fn data_block(r: &mut Reader<'_>, c: &Counts) -> Option<(Vec<i64>, Vec<u8>, Vec<i64>)> {
    let mut times = Vec::with_capacity(c.time);
    for _ in 0..c.time {
        times.push(r.be_i64()?);
    }
    let kinds = r.take(c.time)?.to_vec();
    let mut offsets = Vec::with_capacity(c.kind);
    for _ in 0..c.kind {
        offsets.push(i64::from(r.be_i32()?));
        r.take(2)?; // isdst, abbreviation index
    }
    r.take(c.chars + c.leap * 12 + c.isstd + c.isut)?;
    Some((times, kinds, offsets))
}

impl TzData {
    /// A zone from explicit transitions (`times[i]` switches to offset
    /// `offsets[kinds[i]]`) and the rule that governs everything after them.
    #[must_use]
    pub const fn from_transitions(
        times: Vec<i64>,
        kinds: Vec<u8>,
        offsets: Vec<i64>,
        footer: Option<PosixRule>,
    ) -> Self {
        Self {
            times,
            kinds,
            offsets,
            footer,
        }
    }

    /// Parse a zone file; `None` if it is not a version 2+ `TZif` file.
    #[must_use]
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        let mut r = Reader {
            data: bytes,
            pos: 0,
        };
        let (version, first) = header(&mut r)?;
        if version < b'2' {
            return None;
        }
        skip_v1(&mut r, &first)?;
        let (_, second) = header(&mut r)?;
        let (times, kinds, offsets) = data_block(&mut r, &second)?;
        let rest = r.data.get(r.pos..)?;
        let footer = match rest {
            [b'\n', text @ .., b'\n'] if !text.is_empty() => {
                Some(PosixRule::parse(core::str::from_utf8(text).ok()?)?)
            }
            _ => None,
        };
        if offsets.is_empty() {
            return None;
        }
        Some(Self {
            times,
            kinds,
            offsets,
            footer,
        })
    }

    fn type_offset(&self, kind: Option<&u8>) -> i64 {
        kind.and_then(|k| self.offsets.get(usize::from(*k)))
            .or_else(|| self.offsets.first())
            .copied()
            .unwrap_or(0)
    }

    /// The UTC offset in seconds east of UTC at `unix_seconds`.
    #[must_use]
    pub fn offset_at(&self, unix_seconds: i64) -> i64 {
        if self.times.is_empty() {
            return self.footer.as_ref().map_or_else(
                || self.type_offset(None),
                |rule| rule.offset_at(unix_seconds),
            );
        }
        let passed = self.times.partition_point(|&t| t <= unix_seconds);
        if passed == 0 {
            return self.type_offset(None);
        }
        if let (true, Some(rule)) = (passed == self.times.len(), &self.footer) {
            return rule.offset_at(unix_seconds);
        }
        self.type_offset(passed.checked_sub(1).and_then(|i| self.kinds.get(i)))
    }
}
