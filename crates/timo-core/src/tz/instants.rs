//! Wall clock to instant: the inverse of [`super::parts`], with DST gaps and overlaps.

use super::civil::{MS_PER_HOUR, utc_millis};
use super::error::TzError;
use super::parts::{ZonedDateTimeParts, parts_at};
use super::zone::{Zone, resolve};

/// The hours around the target at which the zone's offset is sampled.
const PROBE_HOURS: [i64; 7] = [-36, -24, -12, 0, 12, 24, 36];

/// The zone offsets (in ms) seen around `target`, in first-seen order.
fn sampled_offsets(target: i64, zone: &Zone) -> Result<Vec<i64>, TzError> {
    let mut offsets: Vec<i64> = Vec::new();
    for hours in PROBE_HOURS {
        let probe = target + hours * MS_PER_HOUR;
        let observed = parts_at(probe, zone)?;
        let offset = utc_millis(&observed)? - probe;
        if !offsets.contains(&offset) {
            offsets.push(offset);
        }
    }
    Ok(offsets)
}

/// Port of `packages/types/src/timezone.ts::possibleInstantsForZonedDateTime`.
///
/// Returns the instants (ms, ascending, distinct) at which the zone's wall
/// clock reads `parts`: one on a normal day, two in a fall-back hour, none in a
/// spring-forward gap. Errors are thrown in the TypeScript's order: zone first,
/// then the parts, then each probe.
pub fn possible_instants_for_zoned_date_time(
    parts: &ZonedDateTimeParts,
    time_zone: &str,
) -> Result<Vec<i64>, TzError> {
    let zone = resolve(time_zone).ok_or(TzError::InvalidTimezone)?;
    let target = utc_millis(parts)?;
    let offsets = sampled_offsets(target, &zone)?;
    let mut found = Vec::new();
    for offset in offsets {
        let candidate = target - offset;
        if parts_at(candidate, &zone)? == *parts {
            found.push(candidate);
        }
    }
    found.sort_unstable();
    found.dedup();
    Ok(found)
}

/// Port of `packages/types/src/timezone.ts::instantForZonedDateTime`.
///
/// The earliest candidate: the first occurrence of a repeated fall-back hour.
/// A time that does not exist (a spring-forward gap) is an error.
pub fn instant_for_zoned_date_time(
    parts: &ZonedDateTimeParts,
    time_zone: &str,
) -> Result<i64, TzError> {
    possible_instants_for_zoned_date_time(parts, time_zone)?
        .first()
        .copied()
        .ok_or(TzError::NonexistentLocalTime)
}
