# Timer engine: JavaScript yield points in Rust

`timerService.ts` is correct because JavaScript is single threaded: any stretch
of synchronous code between two `await`s is atomic (inventory X4). Nothing in the
TypeScript locks anything. The port keeps exactly those stretches atomic and
makes every real `await` an explicit `.await`.

## Design

```
TimerRuntime (Arc, async)                 TimerService (sync, &mut self)
  svc: Mutex<TimerService>  ───────────►    one method per atomic stretch
  guard: Box<dyn TrackingAccrualGuard>      store, clock, ids, memo, outbox
  client: Box<dyn SyncClient>
  spawner: Arc<dyn Spawn>
  background: Mutex<Vec<(id, SharedFuture)>>      (= backgroundSyncs)
```

* **Single writer.** All state lives in `TimerService`, behind one mutex in
  `TimerRuntime`. A lock is taken for one atomic stretch and released before any
  `.await`. No lock is ever held across a suspension.
* **Nothing is called out to under the lock.** The mutation listener (`notifyMutation`) and the
  background syncs (`syncInBackground`) are queued by the stretch and started by the runtime right
  after it, with the lock released, in the TypeScript's order (listener first). A listener wired to
  the hydrator therefore cannot deadlock on `current_owner()`. (It did: the listener ran under the
  lock, the hydrator's first poll is eager, and its ready `loadTokens` future let it reach the same
  mutex.) The hydrator also suspends at every `await` of an `async` call, as JavaScript does, so
  nothing of it runs inside the caller's stretch.
* **The guard await is outside the lock and the clock is sampled after it.**
  `start`/`resume_from_idle` await `guard.assert_can_accrue()` first, then take
  the lock and call `start_after_guard`/`resume_after_guard`, which read
  `clock.now()` (SC-14, SC-17).
* **One tick after every `commit*`.** `await this.commitOpen(...)` suspends once even though
  `commitOpen` never does, and the status is read after it. In that tick another call whose guard was
  released in the same turn runs its stretch, so two `start`s released together both answer the
  second one's status, and the clock reads happen in that order. `TimerRuntime::stretch` returns
  whether the stretch reached a commit (`TimerService::committed`, set on entering `commit_open` /
  `commit_closed`) and `after_commit` takes the tick, on success and on a failed write alike.
  `prepareForQuit` clears the exit intent after it. Every `await` of a call of an `async` function
  gets one tick (the guard, `resume`'s `resumeFromIdle`); the harness's `burst` op (several ops in one
  synchronous turn) is what shows the order.
* **No `status()` inside a stretch.** The TypeScript `async` methods end in
  `return this.status()`. A `TimerService` step returns `()`; the runtime starts
  the queued background syncs, then reads the status. That is the TypeScript
  order, and it matters: with a ticking clock `syncInBackground`'s call into
  `HttpSyncClient` samples the clock *before* `status()` does.
  Methods that return `void` in the TypeScript (`pauseForIdle`, `resumeFromIdle`,
  `discardAway`, the meeting functions) use `mutate_void` and never read the
  status, again like the TypeScript (a differing number of clock reads is caught
  by the `perCall` clock of the parity scenarios; it was, and was fixed).
* **`syncInBackground` is eager.** A JavaScript `async` call runs synchronously up
  to its first `await`. `spawn_eager` polls the new task once with a no-op waker
  (so `SyncClient::create/sync` is *called*, and builds its request body, at the
  time the TypeScript calls it), then hands the task to the `Spawn`er, whose own
  first poll registers the real waker. A `Shared` future is both spawned and kept
  in the background set, so `flushUnsynced` can await it (`Promise.allSettled`).
* **An `await` always yields once.** After calling `client.create/sync` the task
  does `yield_once().await`, as a JavaScript `await` suspends even on a settled
  promise. This also guarantees the first, eager poll (made while the runtime
  holds the service lock) never reaches the receipt handling, which locks.
* **Time and I/O are injected.** `Spawn`, `Timers` (`set_interval`,
  `clear_interval`, `set_timeout`), `Clock`, `IdGen`, `SyncClient`,
  `TrackingAccrualGuard`. `ManualExecutor` (`timer/executor.rs`) is the
  deterministic executor the tests use: ready tasks run in wake order, one at a
  time, and `run_until_stalled` is the equivalent of "flush microtasks".

## Every TypeScript `await`

| # | TypeScript (`timerService.ts`) | Rust |
|---|---|---|
| 1 | `start`: `await accrualGuard.assertCanAccrue()` (191) | `TimerRuntime::start`: `guard.assert_can_accrue().await?`, no lock held |
| 2 | `start`: `clock.now()` after it (192) | `TimerService::start_after_guard`, first line, under the lock |
| 3 | `start`: `await commitOpen(...)` (206) | `after_commit`: one `yield_once` after the stretch, then `status()` |
| 4 | `stop`, `prepareForQuit`: `await commitClosed(...)` (213, 226) | same; `prepare_for_quit` clears the exit intent after the tick |
| 5 | `prepareForAway`: no await (`commitClosed` is not used) | one lock acquisition, same order of effects |
| 6 | `resume`: `await resumeFromIdle(clock.now())` (256) | `at` sampled under the lock, then `resume_from_idle(at).await` |
| 7 | `pause`, `pauseForIdle`, `pauseForPermission`: `await commitOpen` (266, 281, 291, 297) | `after_commit`, same as 3 |
| 8 | `resumeFromIdle`: `await accrualGuard.assertCanAccrue()` (305); the paused check before it is **not** repeated after | `resume_from_idle`: `resume_needs_guard()` (lock), `guard.await`, `mutate_void(resume_after_guard)`. If `stop` ran meanwhile `this.open` is `null`: `TimerError::NullEntry` (V8's `TypeError`), *after* one id was consumed, as in the TypeScript (`openSegment(this.open, {segmentId: this.ids.ulid()})` evaluates its arguments first) |
| 9 | `resumeFromIdle`: `await commitOpen` (308) | `after_commit`; `resume` then takes one more tick for the `async` call it awaited |
| 10 | `beginMeeting`, `endMeeting`, `discardAway`: guard await + `commitOpen` [dead in production] | `begin_meeting`, `end_meeting`, `discard_away`, same shape; `discardAway` reads the open segment's start *before* the await |
| 11 | `flushUnsynced`: `await Promise.allSettled([...backgroundSyncs])` (464) | `settle_background()`: `join_all` of the `Shared` futures in the set |
| 12 | `flushUnsynced`: `await trySync(entry, syncState)` per row (482) | `try_sync(...).await?` per row; an error from `markEntryPendingCreate` propagates, every other error is swallowed inside `try_sync` |
| 13 | `trySync`: `await tryCreateThenSync` / `await tryUpdate` (522, 525) | `try_sync` |
| 14 | `tryCreateThenSync`: `await sync.create(entry)` (530); everything up to the next await is inside one `try` (acknowledge, `markEntryCreated`) | `client.create(entry)` called eagerly, `yield_once().await`, `request.await`; then ONE lock acquisition: `after_create_receipt` (`acknowledge`, then `mark_entry_created`); any error ends the task |
| 15 | `tryCreateThenSync`: `await tryUpdate(entry, false)` (537) | `try_update(entry, false).await` |
| 16 | `tryUpdate`: `await sync.sync(entry)` (542); `acknowledge` inside the `try` | `client.sync(entry)`, `yield_once`, `request.await`; one lock acquisition for `acknowledge` (its error is swallowed: it is not an `HttpError`) |
| 17 | `tryUpdate`: 404 branch `markEntryPendingCreate` then `await tryCreateThenSync` (546-547) | one lock acquisition for `mark_entry_pending_create` (an error propagates), then `try_create_then_sync`. `try_update` is boxed because the two call each other |
| 18 | `syncInBackground`: `trySync(...).catch(() => {}).finally(delete)` | `spawn_background`: the task ignores the result and removes itself from the set |
| 19 | `syncDrain.drainNow`: `flushUnsynced().then().catch().finally()`, shared `inFlight` | `TimerSyncDrain::drain_now` checks `in_flight` and reserves it (with the pass's future and a pass number) in ONE lock acquisition, starts the pass after releasing it, and a finishing pass clears only its own number; concurrent callers get the same `SharedFuture` (identity and one-flush-at-a-time are tested on real threads, `timer_threads.rs`); `setTimeout(250)` is `Timers::set_timeout` (injectable here, global in TypeScript) |
| 20 | `TodayLedgerHydrator`: `await loadTokens()` (twice), `await timer.flushUnsynced()`, `await fetchSnapshot()`, `await this.run()` in the queue loop | `TodayLedgerHydrator::run`, the same awaits in the same order, each followed by one `yield_once` (an `await` of an `async` call suspends even when it answers at once); coalescing through `queued` + one `in_flight` future |

## What a lock covers

Exactly one TypeScript stretch each: `start_after_guard`, `stop_step`,
`pause_step`, `pause_for_idle_step`, `pause_for_permission_step`,
`resume_after_guard`, `prepare_for_quit_step`, `prepare_for_away_step` (whose
order is load-bearing: away state, then the durable close, then memory, then the
notice, then the clear), `accept_server_finalization_step`, `recover`,
`recover_away`, `after_create_receipt`, `acknowledge`, `status`, ...

## How the interleavings are proven

`parity/src/scenarios/timer*.ts` drives the REAL `TimerService` with a guard that
can *hold* its call until released and a network that answers a request only when
the script delivers it (a FIFO queue, one answer per step, exactly what happened
recorded in the step). The scenarios include the guard pending while
`stop`/`prepareForAway`/`prepareForQuit`/`recover` run, two concurrent `start`s,
a guard released with a refusal, and background syncs answered out of order and
after newer mutations. The Rust replay (`timo-store/tests/timer_scenarios.rs`) runs
the same scripts through `TimerRuntime` on `ManualExecutor` and must reproduce
every step byte for byte. 636 scenarios (136 hand-written, 500 seeded), including `burst`s (several ops in one
synchronous turn: the two-starts case the review reproduced, ticking-clock variants, a listener
that throws between two calls); two soak runs of 3,636 scenarios (~103,000 steps each) with other
seeds are also clean.

## Not expressible deterministically

* **How many ticks some awaits take.** Each await of a call of an `async` function costs one tick
  here. JavaScript can cost more: `Promise.allSettled` takes several, the real `HttpSyncClient` /
  `api()` chain adds a few between a response and the awaiting `trySync`, and a promise already
  settled within the very tick differs again. The harness shows none of it because its network
  answers only when a script delivers, one delivery per turn; the `burst` op only combines guard
  releases and calls. The ported unit tests, which use immediately-resolving mocks, run the queued
  tasks at each `await` boundary (`Fixture::run`), and every assertion of the 78 ported tests holds.
  Argued, not observed, for a response delivered in the same turn as another event.
* **Real-thread races.** Within the Rust runtime two commands from two threads are serialised by
  the mutex, in lock order; JavaScript serialises them in event order. The listener and the syncs
  start after the stretch and the status is read in a second lock acquisition, so another thread can
  run between them. The single-threaded replay cannot show this by design; `timer_threads.rs` runs
  the real runtime, hydrator and drain on a thread-per-task spawner (no deadlock; one flush at a
  time).
