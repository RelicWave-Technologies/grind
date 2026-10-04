//! Replaying a recorded scenario through the Rust runtime and stores.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use core::future::Future;
use core::task::{Context, Waker};
use futures_util::future::FutureExt;
use rusqlite::Connection;
use timo_core::timer::TimerRuntime;
use timo_core::timer::executor::ManualExecutor;
use timo_core::timer::traits::{BusinessDayProvider, ServerLedgerCache};
use timo_core::timer::types::{DayWindow, TimerOwner, TodayLedgerMode};
use timo_core::timer::{TimerError, TimerService};
use timo_store::timer::{SqliteEntryStore, SqliteTodayLedgerStore, open_in_memory};

use super::dump::{dump_cache, dump_entries, dump_meta};
use super::records::{ErrRec, OkRec, OpValue, ResultRec, Settled, text};
use super::scenario::{BusinessDaySpec, Delivery, Op, Scenario, SeedRow, SnapshotIn};
use super::world::{CounterIds, Net, Outcome, ScriptedGuard, SharedClock, World};

type Slot = Arc<Mutex<Option<Result<OpValue, String>>>>;

struct Flight {
    op: usize,
    slot: Slot,
    reported: bool,
}

/// What the recorded step supplies as inputs: deliveries and a snapshot.
#[derive(Default)]
pub struct Supplied {
    pub deliveries: Vec<Delivery>,
    pub snapshot: Option<SnapshotIn>,
}

struct SharedCache(Arc<SqliteTodayLedgerStore>);

impl ServerLedgerCache for SharedCache {
    fn list(
        &self,
        owner: &TimerOwner,
        window: DayWindow,
        now: f64,
    ) -> Result<Vec<timo_core::today_ledger::ServerLedgerEntry>, TimerError> {
        self.0.list(owner, window, now)
    }
}

struct Provider {
    spec: ProviderKind,
}

enum ProviderKind {
    None,
    Fixed(f64, f64),
    Offset(f64),
}

impl BusinessDayProvider for Provider {
    fn window(&self, now: f64) -> Option<DayWindow> {
        use timo_core::js::math::{div, mul};
        use timo_core::js::number::{add, floor, sub};
        match self.spec {
            ProviderKind::None => None,
            ProviderKind::Fixed(start, end) => Some(DayWindow { start, end }),
            ProviderKind::Offset(offset) => {
                const DAY: f64 = 86_400_000.0;
                let start = sub(mul(floor(div(add(now, offset), DAY)), DAY), offset);
                Some(DayWindow {
                    start,
                    end: add(start, DAY),
                })
            }
        }
    }
}

pub struct Run {
    pub(super) rt: Arc<TimerRuntime>,
    pub(super) exec: ManualExecutor,
    pub(super) world: World,
    pub(super) clock: SharedClock,
    pub(super) guard: ScriptedGuard,
    pub(super) ids: CounterIds,
    pub(super) net: Net,
    pub(super) db: timo_store::timer::SharedDb,
    pub(super) cache: Arc<SqliteTodayLedgerStore>,
    pub(super) owner: Option<TimerOwner>,
    flights: Vec<Flight>,
    pub(super) listener_count: Arc<AtomicU32>,
    pub(super) listener_throws: Arc<AtomicBool>,
    last_rows: BTreeMap<String, String>,
    last_meta: Option<String>,
    last_cache: Option<String>,
}

fn legacy_tables(db: &Connection) {
    db.execute_batch(
        "CREATE TABLE local_entries (
      id          TEXT PRIMARY KEY,
      client_uuid TEXT NOT NULL UNIQUE,
      ended_at    INTEGER,
      synced      INTEGER NOT NULL DEFAULT 0,
      json        TEXT NOT NULL
    );
    CREATE TABLE timer_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );",
    )
    .unwrap();
}

fn seed(db: &Connection, rows: &[SeedRow], legacy: bool) {
    for r in rows {
        if legacy {
            db.execute(
                "INSERT INTO local_entries (id, client_uuid, ended_at, synced, json) VALUES (?, ?, ?, ?, ?)",
                rusqlite::params![r.id, r.client_uuid, r.ended_at, r.synced, r.json_text],
            )
            .unwrap();
        } else {
            db.execute(
                "INSERT INTO local_entries (id, client_uuid, ended_at, synced, sync_state, owner_user_id, owner_workspace_id,
           acknowledged_revision, acknowledged_hash, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                rusqlite::params![
                    r.id,
                    r.client_uuid,
                    r.ended_at,
                    r.synced,
                    r.sync_state.clone().unwrap_or_else(|| "pending_create".to_owned()),
                    r.owner_user_id,
                    r.owner_workspace_id,
                    r.acknowledged_revision,
                    r.acknowledged_hash,
                    r.json_text
                ],
            )
            .unwrap();
        }
    }
}

pub(super) fn mode_of(mode: &str) -> TodayLedgerMode {
    match mode {
        "OFF" => TodayLedgerMode::Off,
        "SHADOW" => TodayLedgerMode::Shadow,
        _ => TodayLedgerMode::Visible,
    }
}

impl Run {
    /// Build the world, the stores and the runtime for one scenario.
    pub fn new(scenario: &Scenario) -> Result<Self, String> {
        let setup = &scenario.setup;
        let world = World::new(setup.mono0, setup.true0, setup.skew, setup.per_call);
        let clock = SharedClock::new(&world);
        let db = open_in_memory().map_err(|e| e.to_string())?;
        if setup.legacy_schema {
            legacy_tables(&db.lock().unwrap());
            seed(&db.lock().unwrap(), &setup.seed_rows, true);
        }
        let store = SqliteEntryStore::new(db.clone()).map_err(|e| e.to_string())?;
        let device = world.clone();
        let cache = Arc::new(
            SqliteTodayLedgerStore::new(db.clone(), Arc::new(move || device.device_now()))
                .map_err(|e| e.to_string())?,
        );
        if !setup.legacy_schema {
            seed(&db.lock().unwrap(), &setup.seed_rows, false);
        }
        let guard = ScriptedGuard::new();
        let ids = CounterIds::new(setup.id_start);
        let net = Net::new(clock.clone());
        let mut service = TimerService::new(
            Box::new(store),
            Arc::new(clock.clone()),
            Box::new(ids.clone()),
        )
        .with_server_cache(Box::new(SharedCache(Arc::clone(&cache))));
        service = match setup.business_day {
            BusinessDaySpec::Utc => service,
            BusinessDaySpec::None => service.with_business_day(Box::new(Provider {
                spec: ProviderKind::None,
            })),
            BusinessDaySpec::Fixed { start, end } => {
                service.with_business_day(Box::new(Provider {
                    spec: ProviderKind::Fixed(start, end),
                }))
            }
            BusinessDaySpec::Offset { offset_ms } => {
                service.with_business_day(Box::new(Provider {
                    spec: ProviderKind::Offset(offset_ms),
                }))
            }
        };
        service.set_today_ledger_mode(mode_of(&setup.mode));
        let exec = ManualExecutor::new();
        let rt = TimerRuntime::new(
            service,
            Box::new(guard.clone()),
            Box::new(net.clone()),
            Arc::new(exec.clone()),
        );
        let listener_count = Arc::new(AtomicU32::new(0));
        let listener_throws = Arc::new(AtomicBool::new(false));
        let (count, throws) = (Arc::clone(&listener_count), Arc::clone(&listener_throws));
        rt.lock().set_mutation_listener(Some(Arc::new(move || {
            count.fetch_add(1, Ordering::SeqCst);
            if throws.load(Ordering::SeqCst) {
                // `resume_unwind` skips the panic hook: this is a thrown error, not a crash.
                std::panic::resume_unwind(Box::new("listener failed"));
            }
        })));
        if setup.bind {
            rt.lock()
                .bind_owner(setup.owner.as_ref(), setup.claim_legacy)
                .map_err(|e| e.to_string())?;
        }
        Ok(Self {
            rt,
            exec,
            world,
            clock,
            guard,
            ids,
            net,
            db,
            cache,
            owner: setup.owner.clone(),
            flights: Vec::new(),
            listener_count,
            listener_throws,
            last_rows: BTreeMap::new(),
            last_meta: None,
            last_cache: None,
        })
    }

    /// Start an op the way JavaScript calls an async function: run it up to its
    /// first suspension now, then leave the rest to the executor.
    pub(super) fn launch<F>(&mut self, op: usize, fut: F)
    where
        F: Future<Output = Result<OpValue, TimerError>> + Send + 'static,
    {
        let slot: Slot = Arc::new(Mutex::new(None));
        let out = Arc::clone(&slot);
        let mut task = async move {
            let result = fut.await.map_err(|e| e.to_string());
            *out.lock().unwrap_or_else(PoisonError::into_inner) = Some(result);
        }
        .boxed();
        let ready = task
            .poll_unpin(&mut Context::from_waker(Waker::noop()))
            .is_ready();
        if !ready {
            timo_core::timer::exec::Spawn::spawn(&self.exec, task);
        }
        self.flights.push(Flight {
            op,
            slot,
            reported: false,
        });
    }

    pub(super) fn deliver(&self, delivery: &Delivery) {
        let outcome = if let Some(text) = &delivery.resolve {
            Outcome::Resolved(text.clone())
        } else if let Some(http) = &delivery.reject_http {
            Outcome::RejectHttp {
                status: http.status,
                body: http.body.clone(),
            }
        } else {
            Outcome::RejectError(delivery.reject_error.clone().unwrap_or_default())
        };
        assert!(
            self.net.deliver(delivery.id, outcome),
            "recorded delivery {} is not pending",
            delivery.id
        );
        self.exec.run_until_stalled();
    }

    /// Run one op, then the "flush microtasks" and the recording of the step.
    pub fn step(
        &mut self,
        index: usize,
        op: &Op,
        supplied: &Supplied,
    ) -> Vec<(&'static str, String)> {
        self.net.take_calls();
        self.listener_count.store(0, Ordering::SeqCst);
        self.apply(index, op, supplied);
        self.exec.run_until_stalled();
        self.record(index)
    }

    pub(super) fn open_entry_id(&self) -> Option<String> {
        self.db
            .lock()
            .unwrap()
            .query_row(
                "SELECT id FROM local_entries WHERE ended_at IS NULL ORDER BY rowid DESC LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .ok()
    }

    fn record(&mut self, index: usize) -> Vec<(&'static str, String)> {
        let mut settled = Vec::new();
        for flight in &mut self.flights {
            let done = flight.slot.lock().unwrap().take();
            if let (false, Some(result)) = (flight.reported, done) {
                flight.reported = true;
                let result = match result {
                    Ok(ok) => ResultRec::Ok(OkRec { ok }),
                    Err(error) => ResultRec::Err(ErrRec { error }),
                };
                settled.push(Settled {
                    op: flight.op,
                    result,
                });
            }
        }
        let status = match self.rt.status() {
            Ok(status) => text(&status),
            Err(e) => text(&ErrRec {
                error: e.to_string(),
            }),
        };
        let inflight = self.flights.iter().filter(|f| !f.reported).count();
        let mut members: Vec<(&'static str, String)> = vec![
            ("i", text(&index)),
            ("settled", text(&settled)),
            ("status", status),
            ("calls", text(&self.net.take_calls())),
            (
                "listener",
                text(&self.listener_count.load(Ordering::SeqCst)),
            ),
            ("pending", text(&self.net.pending_len())),
            ("inflight", text(&inflight)),
        ];
        self.add_dumps(&mut members);
        members
    }

    fn add_dumps(&mut self, members: &mut Vec<(&'static str, String)>) {
        let db = self.db.lock().unwrap();
        let changed: Vec<_> = dump_entries(&db)
            .into_iter()
            .filter(|row| {
                let (key, body) = (format!("{}", row.rowid), text(row));
                if self.last_rows.get(&key) == Some(&body) {
                    return false;
                }
                self.last_rows.insert(key, body);
                true
            })
            .collect();
        if !changed.is_empty() {
            members.push(("entries", text(&changed)));
        }
        let meta = text(&dump_meta(&db));
        if self.last_meta.as_ref() != Some(&meta) {
            self.last_meta = Some(meta.clone());
            members.push(("meta", meta));
        }
        let cache = text(&dump_cache(&db));
        if self.last_cache.as_ref() != Some(&cache) {
            self.last_cache = Some(cache.clone());
            members.push(("cache", cache));
        }
    }
}
