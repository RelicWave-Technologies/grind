//! 1:1 port of `legacy/agent/src/main/services/timer/todayLedgerHydrator.test.ts`.
#![allow(clippy::unwrap_used, reason = "tests unwrap")]

mod timer_support;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use futures_util::future::{BoxFuture, FutureExt};
use serde_json::{Value, json};
use timer_support::{Gate, RecLogger, run_on};
use timo_core::timer::TimerError;
use timo_core::timer::dto::TodayLedgerResponse;
use timo_core::timer::exec::LogValue;
use timo_core::timer::executor::ManualExecutor;
use timo_core::timer::hydrator::{
    HydratorCache, HydratorDeps, HydratorTimer, StoredTokens, TodayLedgerHydrator,
    TodayLedgerRefreshReason,
};
use timo_core::timer::service::TodayLedgerDiagnostics;
use timo_core::timer::types::{DayWindow, EntryMatch, TimerOwner, TodayLedgerMode};

fn tokens() -> StoredTokens {
    StoredTokens {
        user_id: "user-1".into(),
        workspace_id: "workspace-1".into(),
    }
}

fn response() -> Value {
    json!({
        "complete": true,
        "serverTime": "1970-01-01T00:00:01.000Z",
        "workspaceTimezone": "Asia/Kolkata",
        "entries": [],
        "effectiveEntries": []
    })
}

#[derive(Default)]
struct Counters {
    replace_snapshot: AtomicUsize,
    on_updated: AtomicUsize,
    flush_unsynced: AtomicUsize,
    claim: AtomicUsize,
    diagnostics: AtomicUsize,
    load_tokens: AtomicUsize,
    fetch: AtomicUsize,
    owner_reads: AtomicUsize,
}

struct MockTimer(Arc<Counters>);

impl HydratorTimer for MockTimer {
    fn current_owner(&self) -> Option<TimerOwner> {
        self.0.owner_reads.fetch_add(1, Ordering::SeqCst);
        Some(TimerOwner {
            user_id: "user-1".into(),
            workspace_id: "workspace-1".into(),
        })
    }

    fn flush_unsynced(&self) -> BoxFuture<'static, Result<bool, TimerError>> {
        self.0.flush_unsynced.fetch_add(1, Ordering::SeqCst);
        async { Ok(false) }.boxed()
    }

    fn claim_server_matched_entries(&self, _: &[EntryMatch]) -> Result<usize, TimerError> {
        self.0.claim.fetch_add(1, Ordering::SeqCst);
        Ok(0)
    }

    fn today_ledger_diagnostics(&self) -> Result<Option<TodayLedgerDiagnostics>, TimerError> {
        self.0.diagnostics.fetch_add(1, Ordering::SeqCst);
        Ok(Some(TodayLedgerDiagnostics {
            local_ms: 1_000.0,
            merged_ms: 1_500.0,
            conflicts: 1,
        }))
    }
}

struct MockCache(Arc<Counters>);

impl HydratorCache for MockCache {
    fn replace_snapshot(
        &self,
        _: &TimerOwner,
        _: DayWindow,
        _: &TodayLedgerResponse,
    ) -> Result<(), String> {
        self.0.replace_snapshot.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

type Fetch = Arc<dyn Fn(usize) -> BoxFuture<'static, Result<Value, String>> + Send + Sync>;
type Tokens = Arc<dyn Fn(usize) -> Option<StoredTokens> + Send + Sync>;

struct Overrides {
    mode: Arc<Mutex<TodayLedgerMode>>,
    fetch: Fetch,
    tokens: Tokens,
}

impl Overrides {
    fn new() -> Self {
        Self {
            mode: Arc::new(Mutex::new(TodayLedgerMode::Visible)),
            fetch: Arc::new(|_| async { Ok(response()) }.boxed()),
            tokens: Arc::new(|_| Some(tokens())),
        }
    }
}

struct Harness {
    hydrator: Arc<TodayLedgerHydrator>,
    exec: ManualExecutor,
    counters: Arc<Counters>,
    log: RecLogger,
}

#[allow(
    clippy::needless_pass_by_value,
    reason = "reads like the TypeScript `harness(overrides)`"
)]
fn harness(over: Overrides) -> Harness {
    let counters = Arc::new(Counters::default());
    let exec = ManualExecutor::new();
    let log = RecLogger::default();
    let (mode, fetch, tokens_for) = (
        Arc::clone(&over.mode),
        Arc::clone(&over.fetch),
        Arc::clone(&over.tokens),
    );
    let (c_tokens, c_fetch, c_updated) = (
        Arc::clone(&counters),
        Arc::clone(&counters),
        Arc::clone(&counters),
    );
    let hydrator = TodayLedgerHydrator::new(HydratorDeps {
        timer: Arc::new(MockTimer(Arc::clone(&counters))),
        cache: Arc::new(MockCache(Arc::clone(&counters))),
        get_mode: Box::new(move || *mode.lock().unwrap_or_else(PoisonError::into_inner)),
        load_tokens: Box::new(move || {
            let n = c_tokens.load_tokens.fetch_add(1, Ordering::SeqCst);
            let value = tokens_for(n);
            async move { value }.boxed()
        }),
        get_window: Box::new(|| {
            Some(DayWindow {
                start: 0.0,
                end: 86_400_000.0,
            })
        }),
        fetch_snapshot: Box::new(move |_path| {
            let n = c_fetch.fetch.fetch_add(1, Ordering::SeqCst);
            fetch(n)
        }),
        on_updated: Box::new(move || {
            c_updated.on_updated.fetch_add(1, Ordering::SeqCst);
        }),
        log: Arc::new(log.clone()),
        timers: Arc::new(timer_support::FakeTimers::new(&exec)),
        spawner: Arc::new(exec.clone()),
    });
    Harness {
        hydrator,
        exec,
        counters,
        log,
    }
}

impl Harness {
    fn refresh(&self, reason: TodayLedgerRefreshReason) {
        let done = self.hydrator.refresh(reason);
        run_on(&self.exec, done);
    }

    fn count(&self, pick: fn(&Counters) -> &AtomicUsize) -> usize {
        pick(&self.counters).load(Ordering::SeqCst)
    }
}

mod today_ledger_hydrator {
    use super::*;

    /// A call of `loadTokens()` is awaited: even a promise that is already settled suspends,
    /// so a refresh started from inside another stretch (the timer's mutation listener) has
    /// not touched the timer when `refresh()` returns. Without the suspension the hydrator
    /// ran on into `timer.currentOwner()` inside the caller's own stretch.
    #[test]
    fn does_not_touch_the_timer_before_its_first_suspension() {
        let h = harness(Overrides::new());
        let done = h.hydrator.refresh(TodayLedgerRefreshReason::Mutation);
        assert_eq!(h.count(|c| &c.load_tokens), 1);
        assert_eq!(h.count(|c| &c.owner_reads), 0);
        run_on(&h.exec, done);
        assert!(h.count(|c| &c.owner_reads) >= 1);
        assert_eq!(h.count(|c| &c.replace_snapshot), 1);
    }

    #[test]
    fn replaces_cache_only_after_a_complete_validated_response() {
        let h = harness(Overrides::new());
        h.refresh(TodayLedgerRefreshReason::Manual);
        assert_eq!(h.count(|c| &c.replace_snapshot), 1);
        assert_eq!(h.count(|c| &c.on_updated), 1);
    }

    #[test]
    fn does_not_clear_the_old_cache_when_the_response_is_malformed() {
        let mut over = Overrides::new();
        over.fetch =
            Arc::new(|_| async { Ok(json!({ "complete": false, "entries": [] })) }.boxed());
        let h = harness(over);
        h.refresh(TodayLedgerRefreshReason::Manual);
        assert_eq!(h.count(|c| &c.replace_snapshot), 0);
        assert_eq!(h.log.lines("warn").len(), 1);
    }

    #[test]
    fn discards_a_response_if_the_logged_in_owner_changes_while_it_is_in_flight() {
        let mut over = Overrides::new();
        over.tokens = Arc::new(|n| {
            Some(if n == 0 {
                tokens()
            } else {
                StoredTokens {
                    user_id: "user-2".into(),
                    ..tokens()
                }
            })
        });
        let h = harness(over);
        h.refresh(TodayLedgerRefreshReason::Manual);
        assert_eq!(h.count(|c| &c.replace_snapshot), 0);
    }

    #[test]
    fn runs_a_queued_auth_refresh_after_an_older_session_request_completes() {
        let gate = Gate::default();
        let first = gate.clone();
        let mut over = Overrides::new();
        over.fetch = Arc::new(move |n| {
            let first = first.clone();
            async move {
                if n == 0 {
                    first.wait().await;
                }
                Ok(response())
            }
            .boxed()
        });
        let h = harness(over);
        let initial = h.hydrator.refresh(TodayLedgerRefreshReason::Interval);
        let queued = h.hydrator.refresh(TodayLedgerRefreshReason::Auth);
        gate.open();
        run_on(&h.exec, async move {
            initial.await;
            queued.await;
        });
        assert_eq!(h.count(|c| &c.fetch), 2);
    }

    #[test]
    fn does_no_work_while_hydration_is_off() {
        let over = Overrides::new();
        *over.mode.lock().unwrap() = TodayLedgerMode::Off;
        let h = harness(over);
        h.refresh(TodayLedgerRefreshReason::Manual);
        assert_eq!(h.count(|c| &c.load_tokens), 0);
        assert_eq!(h.count(|c| &c.fetch), 0);
        assert_eq!(h.count(|c| &c.flush_unsynced), 0);
        assert_eq!(h.count(|c| &c.replace_snapshot), 0);
        assert_eq!(h.count(|c| &c.on_updated), 0);
    }

    #[test]
    fn caches_and_compares_in_shadow_mode_without_claiming_rows_or_updating_the_ui() {
        let over = Overrides::new();
        *over.mode.lock().unwrap() = TodayLedgerMode::Shadow;
        let h = harness(over);
        h.refresh(TodayLedgerRefreshReason::Manual);
        assert_eq!(h.count(|c| &c.replace_snapshot), 1);
        assert_eq!(h.count(|c| &c.diagnostics), 1);
        assert_eq!(h.count(|c| &c.claim), 0);
        assert_eq!(h.count(|c| &c.on_updated), 0);
        let shadow: Vec<_> = h
            .log
            .lines("debug")
            .into_iter()
            .filter(|l| l.message == "today ledger shadow comparison complete")
            .collect();
        assert_eq!(shadow.len(), 1);
        for (key, value) in [
            ("localMs", 1_000.0),
            ("mergedMs", 1_500.0),
            ("deltaMs", 500.0),
            ("conflicts", 1.0),
        ] {
            assert!(
                shadow[0]
                    .meta
                    .contains(&(key.to_owned(), LogValue::Number(value))),
                "{key}"
            );
        }
    }

    #[test]
    fn discards_an_in_flight_response_when_hydration_is_disabled() {
        let over = Overrides::new();
        let mode = Arc::clone(&over.mode);
        let mut over = over;
        over.fetch = Arc::new(move |_| {
            *mode.lock().unwrap() = TodayLedgerMode::Off;
            async { Ok(response()) }.boxed()
        });
        let h = harness(over);
        h.refresh(TodayLedgerRefreshReason::Manual);
        assert_eq!(h.count(|c| &c.replace_snapshot), 0);
        assert_eq!(h.count(|c| &c.on_updated), 0);
    }
}
