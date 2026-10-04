# timo-core timer engine: parity notes

Covers `crates/timo-core/src/timer/` (the port of
`legacy/agent/src/main/services/timer/{types,timerService,syncDrain,todayLedgerHydrator}.ts`,
the request bodies of `syncClient.ts` and `services/serverClock.ts`). The
persistence half is in `crates/timo-store/PARITY-timer.md`. The mapping of every
`await` is in `src/timer/CONCURRENCY.md`.

## How it is proven

* **Differential scenarios.** `parity/src/scenarios/timer*.ts` runs the REAL
  `TimerService`, `SqliteEntryStore`, `SqliteTodayLedgerStore`, `HttpSyncClient`
  (its real request bodies) and `serverClock` on `:memory:` better-sqlite3 under
  a scripted machine (fractional-ms monotonic clock that can tick on every read,
  device clock with skew, counter ids, a controllable guard, a network answered
  only by the script) and records, after EVERY op: the op result or error,
  `status()`, every changed `local_entries` row (all columns, `typeof(ended_at)`,
  rowid order), `timer_meta`, the server cache, the exact sync request bodies and
  the mutation-listener count. `crates/timo-store/tests/timer_scenarios.rs`
  replays them and compares each output member byte for byte (636 scenarios:
  136 hand-written (one per SC item of inventory 2.2-2.4 and X1-X5; rows of every historical
  entry shape; failures injected between durable effects; ops in one synchronous turn), plus 500
  seeded random of 5-40 ops. Soak: two other seeds, 3,636 scenarios and ~103,000 steps each,
  identical.
  Mutation checks (dropping `safe_close_at`'s clamp; not bumping the ledger epoch
  in `mark_entry_synced`) fail the replay at once.
* **Unit tests ported 1:1** (same names, snake_case, `describe` as a module):
  `timerService.test.ts` 78 (84 here: the three skew cases of "can never
  over-credit" are three modules), `syncDrain.test.ts` 10,
  `todayLedgerHydrator.test.ts` 7, `serverClock.test.ts` 17.
* The scenarios supply what the environment answered (network responses, the
  snapshot a server returned) in the recorded step; the Rust side is never given
  a model of the server.

## Quirks copied (not fixed)

1. X3 revision semantics (`close_time_entry`/`open_segment` bump from the input
   entry), `pauseForPermission` on a paused entry bumps manually, `recover*`
   re-label `closeReason` without a bump.
2. **The exit intent is write-only** (`prepareForQuit` writes it, nothing reads it).
3. **The ledger memo is only invalidated by `write_entry`/`mark_entry_*`.**
   `switchEntry`, `bindOwner`, `claimUnownedEntries` and
   `claimServerMatchedEntries` do not bump the epoch: after a task switch, or an
   owner change inside the 10 s TTL, `status()` can read the previous rows.
4. **`recoverAway` leaves a different open entry open** (it only clears the away
   state and writes a notice when none exists).
5. **Hash comparison over fractional stamps.** `acknowledge` hashes the agent's
   fractional stamps; the server hashes ISO-parsed integer milliseconds, so an
   exact acknowledgement needs integral stamps. A mismatch changes nothing and
   the entry stays pending (retried every pass).
6. `resumeFromIdle` checks "paused" before the guard await and not after: a
   `stop` or a second resume in between gives `TimerError::NullEntry` (after
   consuming one id) or a second WORK segment.
7. `start` on another task closes the open entry with `closeTimeEntry(open, now)`,
   not `safe_close_at`: a clock that stepped back gives a `SegmentError`.
8. `pauseForIdle` writes no `IDLE_TRIMMED` segment; the idle gap is just not
   tracked. `status()` is `workedMs: 0` when the workspace day is unavailable.
9. `flushUnsynced` answers `true` only when its batch limit stopped it with rows
   left, never because a row is still pending.
10. `acceptServerFinalization` does not start a sync; `recover` persists only.
11. `observedAt` of an open entry is the server-aligned clock sampled when the
    request body is built (so two sends of one snapshot differ); timestamps go
    through `toISOString()` and truncate sub-millisecond digits.
12. `ServerClock`: the anchor is lazily seeded from the device clock on first
    use; a correction while tracking is held, even the first; a step is applied
    the moment tracking stops; `serverClockOffsetMs` reads the aligned clock then
    the device clock.
13. Drain: single flight across reasons (a concurrent caller of any reason gets
    the in-flight future); the offline check applies to `interval` only; at most
    20 chained passes, 250 ms apart. Hydrator: the newest queued reason wins,
    one `inFlight` drain, a flush before the read, a session re-check after it.
14. Read-back key order: `asRecoveryNotice` builds `{reason, entryId, recoveredAt, observedAt}`, not
    the written order. `ReadRecoveryNotice` serializes in the read order (the replay prints it
    unchanged: it normalizes nothing).

## Where the port is NOT exact

1. **Mutation-listener panics are caught** with `catch_unwind` (the TypeScript's
   `try/catch`); the listener must be unwind safe.
2. **`new Date(string)`** is only ported for ISO shapes (see `PARITY.md`): in
   `acknowledge` (the `CLOCK_CLAMP` notice time), `ServerClock::note_server_time`
   (`+0530`, legacy formats) and the DTO conversions an unsupported string is an
   error or `None`, where V8 might read a value.
3. **`TimeEntryDto`/`TimerSyncReceipt`/`TodayLedgerResponse` validation** is a
   hand-written equivalent of the zod schemas (`is_iso_datetime` follows zod
   3.25's `datetime({offset:true})` regex by reading it, plus int/min/length
   checks). It agrees on everything the harness generates (valid and invalid
   receipts, owner-mismatched snapshots) but is not fixture-tested against zod,
   and its error text differs.
4. **`Number(text)`** (liveness) handles decimal, `Infinity`, hex/octal/binary and
   surrounding whitespace; `'abc'`, `' 12 '`, `''`, `'0x10'`, `'12abc'` are in the
   scenarios.
5. **`UTC_DAY_PROVIDER`** does not reproduce `Date.UTC`'s year 0-99 mapping
   (unreachable for real instants).
6. **Entry layout.** An entry read from a row keeps its key order and unknown keys through every
   spread, as JavaScript does (`TimeEntry.shape`, see the store's `PARITY-timer.md`). Not kept:
   unknown or reordered keys inside a SEGMENT (never written by any release), and a row lacking a
   required key (`endedAt`, ...), which is written back with `null`.
7. **The monotonic source (`performance.now()`) and the device clock are the
   shell's**: `ServerClock` takes both as traits; `timo-core` reads neither.
8. **The HTTP transport** (`api()`, the 15 s timeout, `TimerSyncReceipt.parse`'s
   message text) belongs to `timo-sync`; here `SyncClient` is a trait and only the
   request bodies (`sync_payload.rs`) are ported and fixture-compared.
9. **Microtask ticks** are reproduced where the harness can show them (the tick after every
   `commit*`, after each awaited `async` call, the unconditional suspension of the hydrator's
   awaits) and not for `Promise.allSettled`'s several ticks, the ticks inside the real
   `HttpSyncClient`, or a promise settled within the very tick (`CONCURRENCY.md`).
10. **Real-thread interleaving.** The mutation listener and the background syncs start after the
   stretch, outside the service lock (a listener may call straight back in), and the status is read
   in a second lock acquisition; another thread can run between them. JavaScript has no such gap.
11. **`localeCompare` follows the ICU default locale of the process**, which the shell must give
   (`js::collate::set_default_locale`, `posix_locale_tag`); see core `PARITY.md`, "Locale".
