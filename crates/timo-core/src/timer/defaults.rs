//! The default collaborators `TimerService`'s constructor falls back to.
//!
//! Port of `UTC_DAY_PROVIDER` and `EMPTY_SERVER_CACHE` in `timerService.ts`.

use super::error::TimerError;
use super::traits::{BusinessDayProvider, ServerLedgerCache};
use super::types::{DayWindow, TimerOwner};
use crate::js::number::{add, f64_to_i64, i64_to_f64, trunc};
use crate::today_ledger::ServerLedgerEntry;

const MS_PER_DAY: i64 = 86_400_000;
/// `TimeClip`'s limit: past it `new Date(x)` is an Invalid Date.
const MAX_TIME: f64 = 8_640_000_000_000_000.0;

/// `UTC_DAY_PROVIDER`: the UTC calendar day containing `now`.
#[derive(Debug, Clone, Copy, Default)]
pub struct UtcDayProvider;

impl BusinessDayProvider for UtcDayProvider {
    fn window(&self, now: f64) -> Option<DayWindow> {
        // `Date.UTC(y, m, d)` of an Invalid Date is NaN, and so is the end.
        let invalid = DayWindow {
            start: f64::NAN,
            end: f64::NAN,
        };
        if !now.is_finite() || now.abs() > MAX_TIME {
            return Some(invalid);
        }
        // `new Date(now)` truncates the fraction towards zero.
        let Ok(ms) = f64_to_i64(trunc(now)) else {
            return Some(invalid);
        };
        let Ok(start) = i64_to_f64(ms.div_euclid(MS_PER_DAY) * MS_PER_DAY) else {
            return Some(invalid);
        };
        Some(DayWindow {
            start,
            end: add(start, 86_400_000.0),
        })
    }
}

/// `EMPTY_SERVER_CACHE`: no server rows.
#[derive(Debug, Clone, Copy, Default)]
pub struct EmptyServerCache;

impl ServerLedgerCache for EmptyServerCache {
    fn list(
        &self,
        _: &TimerOwner,
        _: DayWindow,
        _: f64,
    ) -> Result<Vec<ServerLedgerEntry>, TimerError> {
        Ok(Vec::new())
    }
}
