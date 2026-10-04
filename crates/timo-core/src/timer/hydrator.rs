//! Queued refresh of the server's day snapshot.
//!
//! Port of `legacy/agent/src/main/services/timer/todayLedgerHydrator.ts`.
//! Refreshes coalesce: the newest reason wins and one drain loop serves them all.

use core::fmt::Write as _;
use std::sync::{Arc, Mutex, PoisonError};

use futures_util::future::FutureExt;

use super::dto::TodayLedgerResponse;
use super::exec::{LogValue, SharedFuture, TimerId, spawn_eager, yield_once};
use super::types::{DayWindow, EntryMatch, TimerOwner, TodayLedgerMode};
use crate::js::iso::to_iso_string;
use crate::js::number::sub;
use crate::types::TimeEntrySource;

pub use super::hydrator_types::{
    HydratorCache, HydratorDeps, HydratorTimer, StoredTokens, TodayLedgerRefreshReason,
};

#[derive(Default)]
struct State {
    in_flight: Option<SharedFuture>,
    queued: Option<TodayLedgerRefreshReason>,
    interval: Option<TimerId>,
}

/// Port of `TodayLedgerHydrator`.
pub struct TodayLedgerHydrator {
    deps: HydratorDeps,
    state: Mutex<State>,
}

impl std::fmt::Debug for TodayLedgerHydrator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TodayLedgerHydrator")
            .finish_non_exhaustive()
    }
}

/// `new URLSearchParams(...).toString()` escaping (`application/x-www-form-urlencoded`).
fn form_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(char::from(byte));
            }
            b' ' => out.push('+'),
            other => {
                // Writing to a String cannot fail.
                let _written = write!(out, "%{other:02X}");
            }
        }
    }
    out
}

impl TodayLedgerHydrator {
    #[must_use]
    pub fn new(deps: HydratorDeps) -> Arc<Self> {
        Arc::new(Self {
            deps,
            state: Mutex::new(State::default()),
        })
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Port of `TodayLedgerHydrator.start`: a 60 s `interval` refresh.
    pub fn start(self: &Arc<Self>) {
        let mut state = self.state();
        if state.interval.is_some() {
            return;
        }
        let this = Arc::clone(self);
        state.interval = Some(self.deps.timers.set_interval(
            60_000.0,
            Box::new(move || {
                let _running = this.refresh(TodayLedgerRefreshReason::Interval);
            }),
        ));
    }

    /// Port of `TodayLedgerHydrator.stop`.
    pub fn stop(&self) {
        if let Some(id) = self.state().interval.take() {
            self.deps.timers.clear_interval(id);
        }
    }

    /// Port of `TodayLedgerHydrator.refresh`: the newest reason is queued and
    /// every caller gets the one in-flight drain.
    pub fn refresh(self: &Arc<Self>, reason: TodayLedgerRefreshReason) -> SharedFuture {
        let mut state = self.state();
        state.queued = Some(reason);
        if let Some(in_flight) = state.in_flight.clone() {
            return in_flight;
        }
        let this = Arc::clone(self);
        let task = async move {
            this.drain_queue().await;
            this.state().in_flight = None;
        };
        let shared = task.boxed().shared();
        state.in_flight = Some(shared.clone());
        drop(state);
        spawn_eager(self.deps.spawner.as_ref(), &shared);
        shared
    }

    async fn drain_queue(self: &Arc<Self>) {
        loop {
            let Some(reason) = self.state().queued.take() else {
                return;
            };
            // `await this.run(reason)`: an `async` function's promise.
            let outcome = self.run(reason).await;
            yield_once().await;
            if let Err(err) = outcome {
                // A snapshot is advisory: keep the last complete cache.
                self.deps.log.warn(
                    "today ledger refresh failed; keeping previous cache",
                    &[
                        ("reason", LogValue::Text(reason.as_str().to_owned())),
                        ("err", LogValue::Text(err)),
                    ],
                );
            }
        }
    }

    fn debug(&self, message: &str, reason: TodayLedgerRefreshReason) {
        let meta = [("reason", LogValue::Text(reason.as_str().to_owned()))];
        self.deps.log.debug(message, &meta);
    }

    /// Port of `TodayLedgerHydrator.run`.
    async fn run(self: &Arc<Self>, reason: TodayLedgerRefreshReason) -> Result<(), String> {
        let deps = &self.deps;
        if (deps.get_mode)() == TodayLedgerMode::Off {
            return Ok(());
        }
        // Every `await` of a call to an `async` function suspends at least once, a ready
        // answer included: nothing below runs inside the caller's stretch (a mutation
        // listener's, say), so nothing here can touch the timer while that stretch runs.
        let session = (deps.load_tokens)().await;
        yield_once().await;
        let window = (deps.get_window)();
        let (Some(session), Some(window)) = (session, window) else {
            return Ok(());
        };
        let owner = TimerOwner {
            user_id: session.user_id,
            workspace_id: session.workspace_id,
        };
        if deps.timer.current_owner().as_ref() != Some(&owner) {
            return Ok(());
        }
        let flushed = deps.timer.flush_unsynced().await;
        yield_once().await;
        if let Err(err) = flushed {
            let meta = [
                ("reason", LogValue::Text(reason.as_str().to_owned())),
                ("err", LogValue::Text(err.to_string())),
            ];
            deps.log
                .debug("today ledger continuing with pending local rows", &meta);
        }
        let response = self.fetch(window).await?;
        let current = (deps.load_tokens)().await;
        yield_once().await;
        let still = current
            .as_ref()
            .is_some_and(|c| c.user_id == owner.user_id && c.workspace_id == owner.workspace_id);
        if !still {
            self.debug("discarded today ledger from an older login session", reason);
            return Ok(());
        }
        let mode = (deps.get_mode)();
        if mode == TodayLedgerMode::Off {
            self.debug(
                "discarded today ledger because hydration was disabled",
                reason,
            );
            return Ok(());
        }
        validate_owner(&response, &owner)?;
        deps.cache.replace_snapshot(&owner, window, &response)?;
        self.finish(reason, mode, &response)
    }

    async fn fetch(&self, window: DayWindow) -> Result<TodayLedgerResponse, String> {
        let from = to_iso_string(window.start).map_err(|e| e.to_string())?;
        let to = to_iso_string(window.end).map_err(|e| e.to_string())?;
        let path = format!(
            "/v1/agent/today-ledger?from={}&to={}",
            form_encode(&from),
            form_encode(&to)
        );
        let fetched = (self.deps.fetch_snapshot)(path).await;
        yield_once().await;
        let raw = fetched?;
        let response: TodayLedgerResponse =
            serde_json::from_value(raw).map_err(|e| e.to_string())?;
        response.validate().map_err(|e| e.to_string())?;
        Ok(response)
    }

    /// The SHADOW / VISIBLE tail of `run`.
    fn finish(
        &self,
        reason: TodayLedgerRefreshReason,
        mode: TodayLedgerMode,
        response: &TodayLedgerResponse,
    ) -> Result<(), String> {
        let deps = &self.deps;
        let reason_meta = ("reason", LogValue::Text(reason.as_str().to_owned()));
        let count = |n: usize| LogValue::Number(f64::from(u32::try_from(n).unwrap_or(u32::MAX)));
        if mode == TodayLedgerMode::Shadow {
            let d = deps
                .timer
                .today_ledger_diagnostics()
                .map_err(|e| e.to_string())?;
            let num = |v: Option<f64>| v.map_or(LogValue::Null, LogValue::Number);
            deps.log.debug(
                "today ledger shadow comparison complete",
                &[
                    reason_meta,
                    ("entries", count(response.entries.len())),
                    ("localMs", num(d.map(|d| d.local_ms))),
                    ("mergedMs", num(d.map(|d| d.merged_ms))),
                    ("deltaMs", num(d.map(|d| sub(d.merged_ms, d.local_ms)))),
                    (
                        "conflicts",
                        d.map_or(LogValue::Null, |d| count(d.conflicts)),
                    ),
                ],
            );
            return Ok(());
        }
        let matches: Vec<EntryMatch> = response
            .entries
            .iter()
            .map(|e| EntryMatch {
                id: e.id.clone(),
                client_uuid: e.client_uuid.clone(),
            })
            .collect();
        deps.timer
            .claim_server_matched_entries(&matches)
            .map_err(|e| e.to_string())?;
        (deps.on_updated)();
        let manual = response
            .approved_manual_entries
            .as_ref()
            .map_or(0, Vec::len);
        deps.log.debug(
            "today ledger snapshot refreshed",
            &[
                reason_meta,
                ("autoEntries", count(response.entries.len())),
                ("approvedManualEntries", count(manual)),
            ],
        );
        Ok(())
    }
}

/// The ownership check between the session re-check and `replaceSnapshot`.
fn validate_owner(response: &TodayLedgerResponse, owner: &TimerOwner) -> Result<(), String> {
    let manual = response
        .approved_manual_entries
        .as_deref()
        .unwrap_or_default();
    let bad_auto = response
        .entries
        .iter()
        .any(|e| e.user_id != owner.user_id || e.source != TimeEntrySource::Auto);
    let bad_manual = manual.iter().any(|e| {
        e.user_id != owner.user_id
            || e.source != TimeEntrySource::Manual
            || e.ended_at.is_none()
            || e.segments.iter().any(|s| s.ended_at.is_none())
    });
    if bad_auto || bad_manual {
        return Err("today_ledger_owner_mismatch".to_owned());
    }
    Ok(())
}

/// The hydrator's view of the timer: `timer: TimerService` in `HydratorDeps`.
impl HydratorTimer for std::sync::Arc<super::runtime::TimerRuntime> {
    fn current_owner(&self) -> Option<TimerOwner> {
        self.lock().current_owner()
    }

    fn flush_unsynced(
        &self,
    ) -> futures_util::future::BoxFuture<'static, Result<bool, super::error::TimerError>> {
        let runtime = Arc::clone(self);
        async move { runtime.flush_unsynced_default().await }.boxed()
    }

    fn claim_server_matched_entries(
        &self,
        matches: &[EntryMatch],
    ) -> Result<usize, super::error::TimerError> {
        self.lock().claim_server_matched_entries(matches)
    }

    fn today_ledger_diagnostics(
        &self,
    ) -> Result<Option<super::service::TodayLedgerDiagnostics>, super::error::TimerError> {
        self.lock().today_ledger_diagnostics(None)
    }
}
