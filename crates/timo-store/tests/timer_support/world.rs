//! The simulated machine, the scripted guard, counter ids and the scripted sync
//! network: the test-side twins of `parity/src/scenarios/timerWorld.ts`.
#![allow(
    clippy::float_arithmetic,
    reason = "the world advances fractional-millisecond clocks exactly as the TypeScript harness does"
)]

use core::future::Future;
use core::pin::Pin;
use core::task::{Context, Poll, Waker};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use futures_util::future::{BoxFuture, FutureExt};
use timo_core::timer::dto::TimerSyncReceipt;
use timo_core::timer::error::{GuardError, SyncError};
use timo_core::timer::server_clock::{DeviceClock, MonotonicClock, ServerClock};
use timo_core::timer::traits::{Clock, IdGen, SyncClient, TrackingAccrualGuard};
use timo_core::timer::types::{BlockingCapability, CapabilityState, TrackingReadiness};
use timo_core::types::TimeEntry;

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

struct WorldState {
    mono: f64,
    true_now: f64,
    skew: f64,
    per_call: f64,
}

/// A monotonic source that may tick on every read, and a device wall clock.
#[derive(Clone)]
pub struct World(Arc<Mutex<WorldState>>);

impl World {
    pub fn new(mono0: f64, true0: f64, skew: f64, per_call: f64) -> Self {
        Self(Arc::new(Mutex::new(WorldState {
            mono: mono0,
            true_now: true0,
            skew,
            per_call,
        })))
    }

    /// `performance.now()`: the current reading, then advance by `perCall`.
    pub fn read_mono(&self) -> f64 {
        let mut s = lock(&self.0);
        let value = s.mono;
        s.mono += s.per_call;
        value
    }

    pub fn device_now(&self) -> f64 {
        let s = lock(&self.0);
        s.true_now + s.skew
    }

    pub fn true_now(&self) -> f64 {
        lock(&self.0).true_now
    }

    pub fn advance(&self, ms: f64) {
        let mut s = lock(&self.0);
        s.mono += ms;
        s.true_now += ms;
    }

    pub fn suspend(&self, ms: f64) {
        lock(&self.0).true_now += ms;
    }

    pub fn jump_device(&self, ms: f64) {
        lock(&self.0).skew += ms;
    }
}

pub struct WorldMono(pub World);
pub struct WorldDevice(pub World);

impl MonotonicClock for WorldMono {
    fn now_ms(&self) -> f64 {
        self.0.read_mono()
    }
}

impl DeviceClock for WorldDevice {
    fn now_ms(&self) -> f64 {
        self.0.device_now()
    }
}

/// The real server clock over the simulated machine; also the timer's `Clock`.
#[derive(Clone)]
pub struct SharedClock(Arc<Mutex<ServerClock<WorldMono, WorldDevice>>>);

impl SharedClock {
    pub fn new(world: &World) -> Self {
        let clock = ServerClock::new(WorldMono(world.clone()), WorldDevice(world.clone()));
        Self(Arc::new(Mutex::new(clock)))
    }

    pub fn note_server_time(&self, iso: &str, started: f64, received: f64) -> Option<f64> {
        lock(&self.0).note_server_time(iso, started, received)
    }

    pub fn set_tracking(&self, active: bool) {
        lock(&self.0).set_tracking_active(active);
    }
}

impl Clock for SharedClock {
    fn now(&self) -> f64 {
        lock(&self.0).server_aligned_now()
    }
}

/// Counter ids that sort like ULIDs: `ID00000001`.
#[derive(Clone, Default)]
pub struct CounterIds(Arc<AtomicU64>);

impl CounterIds {
    pub fn new(start: u64) -> Self {
        Self(Arc::new(AtomicU64::new(start)))
    }

    pub fn set(&self, n: u64) {
        self.0.store(n, Ordering::SeqCst);
    }
}

impl IdGen for CounterIds {
    fn ulid(&mut self) -> String {
        let n = self.0.fetch_add(1, Ordering::SeqCst) + 1;
        format!("ID{n:08}")
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum GuardMode {
    Allow,
    Deny,
    Hold,
}

struct Gate {
    outcome: Option<bool>,
    waker: Option<Waker>,
}

struct GateFuture(Arc<Mutex<Gate>>);

impl Future for GateFuture {
    type Output = Result<(), GuardError>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let mut gate = lock(&self.0);
        match gate.outcome {
            Some(true) => Poll::Ready(Err(blocked())),
            Some(false) => Poll::Ready(Ok(())),
            None => {
                gate.waker = Some(cx.waker().clone());
                Poll::Pending
            }
        }
    }
}

fn blocked() -> GuardError {
    GuardError::Blocked(Box::new(TrackingReadiness {
        ready: false,
        checked_at: "1970-01-01T00:00:00.000Z".to_owned(),
        screen_recording: CapabilityState::NeedsSettings,
        accessibility: CapabilityState::Ready,
        blocking_capabilities: vec![BlockingCapability::ScreenRecording],
    }))
}

struct GuardState {
    mode: GuardMode,
    held: VecDeque<Arc<Mutex<Gate>>>,
}

/// A guard that allows, denies, or holds the call until released.
#[derive(Clone)]
pub struct ScriptedGuard(Arc<Mutex<GuardState>>);

impl ScriptedGuard {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(GuardState {
            mode: GuardMode::Allow,
            held: VecDeque::new(),
        })))
    }

    pub fn set_mode(&self, mode: GuardMode) {
        lock(&self.0).mode = mode;
    }

    pub fn release(&self, deny: bool) {
        let gate = lock(&self.0).held.pop_front();
        if let Some(gate) = gate {
            let mut gate = lock(&gate);
            gate.outcome = Some(deny);
            if let Some(waker) = gate.waker.take() {
                waker.wake();
            }
        }
    }
}

impl TrackingAccrualGuard for ScriptedGuard {
    fn assert_can_accrue(&self) -> BoxFuture<'_, Result<(), GuardError>> {
        let mut state = lock(&self.0);
        match state.mode {
            GuardMode::Allow => async { Ok(()) }.boxed(),
            GuardMode::Deny => async { Err(blocked()) }.boxed(),
            GuardMode::Hold => {
                let gate = Arc::new(Mutex::new(Gate {
                    outcome: None,
                    waker: None,
                }));
                state.held.push_back(Arc::clone(&gate));
                GateFuture(gate).boxed()
            }
        }
    }
}

/// What a queued request is finally answered with.
pub enum Outcome {
    Resolved(String),
    RejectHttp { status: u16, body: String },
    RejectError(String),
}

struct Slot {
    outcome: Option<Outcome>,
    waker: Option<Waker>,
}

struct SlotFuture(Arc<Mutex<Slot>>);

impl Future for SlotFuture {
    type Output = Outcome;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Outcome> {
        let mut slot = lock(&self.0);
        if let Some(outcome) = slot.outcome.take() {
            Poll::Ready(outcome)
        } else {
            slot.waker = Some(cx.waker().clone());
            Poll::Pending
        }
    }
}

/// One recorded request (`NetCall` of `timerState.ts`).
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallRecord {
    pub kind: String,
    pub path: String,
    pub method: String,
    pub timeout_ms: Option<f64>,
    pub body: String,
}

struct Pending {
    id: u64,
    path: String,
    slot: Arc<Mutex<Slot>>,
}

#[derive(Default)]
struct NetState {
    pending: Vec<Pending>,
    calls: Vec<CallRecord>,
    next_id: u64,
}

/// The scripted network: a `SyncClient` that builds the real request bodies,
/// queues each request, and answers it only when the replay delivers it.
#[derive(Clone)]
pub struct Net {
    state: Arc<Mutex<NetState>>,
    clock: SharedClock,
}

impl Net {
    pub fn new(clock: SharedClock) -> Self {
        Self {
            state: Arc::new(Mutex::new(NetState {
                next_id: 1,
                ..NetState::default()
            })),
            clock,
        }
    }

    pub fn take_calls(&self) -> Vec<CallRecord> {
        std::mem::take(&mut lock(&self.state).calls)
    }

    pub fn pending_len(&self) -> usize {
        lock(&self.state).pending.len()
    }

    /// Answer the pending request `id`. False when there is none.
    pub fn deliver(&self, id: u64, outcome: Outcome) -> bool {
        let found = {
            let mut state = lock(&self.state);
            state
                .pending
                .iter()
                .position(|p| p.id == id)
                .map(|at| state.pending.remove(at))
        };
        let Some(found) = found else {
            return false;
        };
        let mut slot = lock(&found.slot);
        slot.outcome = Some(outcome);
        if let Some(waker) = slot.waker.take() {
            waker.wake();
        }
        true
    }

    fn request(&self, call: CallRecord) -> BoxFuture<'static, Result<TimerSyncReceipt, SyncError>> {
        let slot = Arc::new(Mutex::new(Slot {
            outcome: None,
            waker: None,
        }));
        let path = call.path.clone();
        {
            let mut state = lock(&self.state);
            let id = state.next_id;
            state.next_id += 1;
            state.calls.push(call);
            state.pending.push(Pending {
                id,
                path: path.clone(),
                slot: Arc::clone(&slot),
            });
        }
        async move {
            match SlotFuture(slot).await {
                Outcome::Resolved(text) => parse_receipt(&text),
                Outcome::RejectHttp { status, body } => Err(SyncError::Http { path, status, body }),
                Outcome::RejectError(message) => Err(SyncError::Other(message)),
            }
        }
        .boxed()
    }
}

/// `TimerSyncReceipt.parse(response)`.
fn parse_receipt(text: &str) -> Result<TimerSyncReceipt, SyncError> {
    let receipt: TimerSyncReceipt =
        serde_json::from_str(text).map_err(|e| SyncError::Other(e.to_string()))?;
    receipt
        .validate()
        .map_err(|e| SyncError::Other(e.to_string()))?;
    Ok(receipt)
}

fn failed(message: String) -> BoxFuture<'static, Result<TimerSyncReceipt, SyncError>> {
    async move { Err(SyncError::Other(message)) }.boxed()
}

impl SyncClient for Net {
    fn create(&self, entry: &TimeEntry) -> BoxFuture<'static, Result<TimerSyncReceipt, SyncError>> {
        use timo_core::js::ser::to_string;
        use timo_core::timer::sync_payload::{Platform, create_body};
        let mut now = || self.clock.now();
        let body = match create_body(entry, &mut now, "0.0.2-parity", Platform::Darwin) {
            Ok(body) => body,
            Err(e) => return failed(e.to_string()),
        };
        let Ok(text) = to_string(&body) else {
            return failed("unserializable body".to_owned());
        };
        self.request(CallRecord {
            kind: "create".to_owned(),
            path: "/v1/time-entries".to_owned(),
            method: "POST".to_owned(),
            timeout_ms: Some(15_000.0),
            body: text,
        })
    }

    fn sync(&self, entry: &TimeEntry) -> BoxFuture<'static, Result<TimerSyncReceipt, SyncError>> {
        use timo_core::js::ser::to_string;
        use timo_core::timer::sync_payload::sync_body;
        let mut now = || self.clock.now();
        let body = match sync_body(entry, &mut now) {
            Ok(body) => body,
            Err(e) => return failed(e.to_string()),
        };
        let Ok(text) = to_string(&body) else {
            return failed("unserializable body".to_owned());
        };
        self.request(CallRecord {
            kind: "sync".to_owned(),
            path: format!("/v1/time-entries/{}/sync", entry.id),
            method: "PUT".to_owned(),
            timeout_ms: Some(15_000.0),
            body: text,
        })
    }
}
