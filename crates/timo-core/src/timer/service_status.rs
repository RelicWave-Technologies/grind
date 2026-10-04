//! The status and the day ledger.
//!
//! Port of `status`, `listToday`, `workedMsByTask`, `todayLedgerDiagnostics`,
//! `workedMsForLocalDay` and `todayProjection` of `timerService.ts`.

use super::boundary::{Interval, interval_union_ms};
use super::error::TimerError;
use super::service::{TimerService, TodayLedgerDiagnostics};
use super::types::{DayWindow, TimerStatus, TodayLedgerMode};
use crate::js::number::{max, min};
use crate::segments::get_open_segment;
use crate::today_ledger::{ReconcileInput, TodayLedgerProjection, reconcile_today_ledger};
use crate::types::{TimeEntry, is_counted};

impl TimerService {
    /// Port of `TimerService.status`. Samples the clock once (and more inside
    /// the ledger memo), so it is called ~1/s by the shell.
    pub fn status(&mut self) -> Result<TimerStatus, TimerError> {
        let now = self.clock.now();
        let worked_ms = self.worked_ms_for_local_day(now)?;
        let Some(open) = &self.open else {
            return Ok(TimerStatus::Idle { worked_ms });
        };
        let active = get_open_segment(open);
        let first = open.segments.first().ok_or(TimerError::EmptySegments)?;
        Ok(TimerStatus::Running {
            entry_id: open.id.clone(),
            revision: open.revision,
            lark_task_guid: open.lark_task_guid.clone().flatten(),
            started_at: first.started_at,
            segment_started_at: active.map(|segment| segment.started_at),
            worked_ms,
            paused: active.is_none(),
            pause_reason: if active.is_none() {
                open.pause_reason
            } else {
                None
            },
        })
    }

    /// Port of `TimerService.todayLedgerDiagnostics` (`now` defaults to the
    /// clock). SHADOW-mode logging only.
    pub fn today_ledger_diagnostics(
        &mut self,
        now: Option<f64>,
    ) -> Result<Option<TodayLedgerDiagnostics>, TimerError> {
        let now = now.unwrap_or_else(|| self.clock.now());
        let window = self.business_day.window(now);
        let owner = self.store.current_owner();
        let (Some(window), Some(owner)) = (window, owner) else {
            return Ok(None);
        };
        let local = self.local_ledger_entries(window.start)?;
        let active = Some(self.open.as_ref().map(|open| open.id.clone()));
        let shared = |server| ReconcileInput {
            local: local.clone(),
            server,
            active_local_entry_id: active.clone(),
            window_start: window.start,
            window_end: window.end,
            now,
        };
        let local_projection = reconcile_today_ledger(&shared(Vec::new()))?;
        let server = self.server_cache.list(&owner, window, now)?;
        let merged = reconcile_today_ledger(&shared(server))?;
        Ok(Some(TodayLedgerDiagnostics {
            local_ms: local_projection.worked_ms,
            merged_ms: merged.worked_ms,
            conflicts: merged.conflicts,
        }))
    }

    /// Port of `TimerService.listToday`: entries with any segment active today,
    /// newest first, including the open one.
    pub fn list_today(&mut self, now: f64) -> Result<Vec<TimeEntry>, TimerError> {
        let Some(window) = self.business_day.window(now) else {
            return Ok(Vec::new());
        };
        let projection = self.today_projection(now, window)?;
        Ok(projection
            .entries
            .into_iter()
            .map(|item| item.entry)
            .collect())
    }

    /// Port of `TimerService.workedMsByTask` (`now` defaults to the clock):
    /// worked ms per Lark task, in first-seen order like a JS `Map`.
    pub fn worked_ms_by_task(
        &mut self,
        now: Option<f64>,
    ) -> Result<Vec<(String, f64)>, TimerError> {
        let now = now.unwrap_or_else(|| self.clock.now());
        let Some(window) = self.business_day.window(now) else {
            return Ok(Vec::new());
        };
        let mut intervals: Vec<(String, Vec<Interval>)> = Vec::new();
        for entry in self.list_today(now)? {
            let Some(guid) = entry
                .lark_task_guid
                .clone()
                .flatten()
                .filter(|g| !g.is_empty())
            else {
                continue;
            };
            let slot = if let Some(index) = intervals.iter().position(|(g, _)| *g == guid) {
                index
            } else {
                intervals.push((guid, Vec::new()));
                intervals.len() - 1
            };
            for segment in entry.segments.iter().filter(|s| is_counted(s.kind)) {
                let start = max(segment.started_at, window.start);
                let end = min(segment.ended_at.unwrap_or(now), window.end);
                if end > start
                    && let Some((_, values)) = intervals.get_mut(slot)
                {
                    values.push(Interval { start, end });
                }
            }
        }
        Ok(intervals
            .into_iter()
            .map(|(guid, mut values)| (guid, interval_union_ms(&mut values)))
            .collect())
    }

    fn worked_ms_for_local_day(&mut self, now: f64) -> Result<f64, TimerError> {
        let Some(window) = self.business_day.window(now) else {
            return Ok(0.0);
        };
        Ok(self.today_projection(now, window)?.worked_ms)
    }

    /// Port of `TimerService.todayProjection`. Server rows take part only in
    /// VISIBLE mode.
    fn today_projection(
        &mut self,
        now: f64,
        window: DayWindow,
    ) -> Result<TodayLedgerProjection, TimerError> {
        let owner = self.store.current_owner();
        let local = self.local_ledger_entries(window.start)?;
        let server = match owner {
            Some(owner) if self.today_ledger_mode == TodayLedgerMode::Visible => {
                self.server_cache.list(&owner, window, now)?
            }
            _ => Vec::new(),
        };
        Ok(reconcile_today_ledger(&ReconcileInput {
            local,
            server,
            active_local_entry_id: Some(self.open.as_ref().map(|open| open.id.clone())),
            window_start: window.start,
            window_end: window.end,
            now,
        })?)
    }
}
