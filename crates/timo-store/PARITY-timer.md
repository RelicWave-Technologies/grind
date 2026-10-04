# timo-store timer tables: parity notes

`crates/timo-store/src/timer/`: `SqliteEntryStore` (`local_entries`, `timer_meta`)
and `SqliteTodayLedgerStore` (`server_entry_cache`, `server_snapshot_meta`), ports
of `legacy/agent/src/main/services/timer/{sqliteStore,todayLedgerStore}.ts`. The
engine they serve is in `crates/timo-core/PARITY-timer.md`.

## How it is proven

* The timer differential scenarios (574, ~14,800 steps) run the real legacy store
  and the Rust store side by side: every changed `local_entries` row (all columns,
  `typeof(ended_at)`, `typeof(acknowledged_revision)`, rowid order), `timer_meta`
  and the server cache are compared as text after every op
  (`tests/timer_scenarios.rs`).
* **Database compatibility** (`tests/timer_compat.rs`,
  `tests/fixtures/timer/compat.json`): the legacy store writes a real `agent.db`
  (fractional timestamps such as `1791133383891.2627`, three owners, unowned
  legacy rows including a `"self"` one and an open one, fractional liveness,
  exit/away/recovery meta, a server snapshot), the file is stored as base64, the
  Rust store opens a scratch copy, answers 42 reads and writes in the order the
  legacy store did, and the rows after every step (including `typeof(ended_at)`)
  are identical. The generator checks the committed bytes: SQLite output is
  deterministic for the same operations.
* Ported 1:1: `sqliteStore.test.ts` (13), `todayLedgerStore.test.ts` (5).

## Numbers

better-sqlite3 binds a JS number as an integer when it is an int32 and as a
double otherwise; the columns are `INTEGER`, and SQLite's column affinity stores
an integral double as an integer and a fractional one as REAL. Measured:
`5`, `1791136668097`, `2^31` are stored as `integer`, `1791136668097.5` as
`real`. The Rust store binds every timestamp as `f64` (a REAL) and the affinity
yields the same storage class, so `typeof(ended_at)` matches (compared on every
step). Reads take `f64`, which accepts both classes.

## Quirks copied

* `upsert`: `synced` is always `0` (the sync state is `pending_*`); the
  acknowledgement columns are kept only when the new JSON is byte-equal to the
  stored JSON (`CASE WHEN excluded.json = local_entries.json`).
* `markCreated`/`markPendingCreate`/`markSynced` match on `json = JSON.stringify(expected)`,
  byte equality, so serialization order and number text matter (`js::ser`).
* Queries order by `rowid` (open: `DESC LIMIT 1`, unsynced: `ASC`, ledger: `DESC`);
  `listLedgerEntries(since)` keeps open rows and rows ending at or after `since`.
* `claimUnownedEntries` claims only rows whose JSON already names the user (the
  placeholder `"self"` stays quarantined) and copies the four un-namespaced meta
  keys when an open row was claimed; `claimServerMatchedEntries` claims only
  closed rows whose exact id and client UUID the snapshot proves.
* Meta keys are `${workspaceId}:${userId}:${key}`; liveness is `String(ts)` read
  back with `Number()`, non-finite is `null`; readers validate shape and return
  `null` otherwise; deleting without an owner is a no-op, writing without one
  throws `timer_owner_unavailable`.
* `parseEntry` normalisation: a missing or non-integer or negative `revision` is
  `0`, an unknown `closeReason`/`pauseReason` is `null`.
* `SqliteTodayLedgerStore.list` returns `[]` unless a snapshot exists for that
  `day_start` AND `day_end` equals the window's (a `day_end` holding text or null is "not
  equal", not an error), and when a row's JSON fails to parse or validate (a column holding a
  non-text value counts as such). A FAILED QUERY (a missing table, an unreadable column)
  throws in the TypeScript, outside its `try`, and is an `Err` here: `ServerLedgerCache::list`
  returns a `Result` and `status()`, `listToday`, `workedMsByTask` and the diagnostics
  propagate it. A server row's effective end is a function of the injected `now` (lease expiry).
* PRAGMAs and migrations are copied: WAL, `synchronous = FULL`,
  `busy_timeout = 5000`, `PRAGMA table_info` feature detection, no versions.
* A recovery notice read back serializes as `{reason, entryId, recoveredAt, observedAt}`
  (`asRecoveryNotice` builds a new object); the written order is `{entryId, recoveredAt, reason,
  observedAt}`. `get_recovery_notice` returns `ReadRecoveryNotice`, whose `Serialize` is the read
  order, and the replay prints it as is.
* A stored entry keeps its layout: `parseEntry` is `{...raw, revision, closeReason, pauseReason}`
  and every later change is a spread, so the row's key order and unknown keys (the `projectId` /
  `taskId` of 63eeba0..807e3df) survive to the next `JSON.stringify`, which is also what the
  `json =` guards compare. `TimeEntry.shape` (`timo-core/src/types/shape.rs`) carries it: an
  existing key keeps its place when its value changes, a missing key is appended. Rows of every
  released shape (v1 63eeba0, v2 44a7b27, v3 807e3df, v4 ea99ad6, v5 a v4 row rewritten by 042198e,
  plus scrambled and extra-key rows) are scenarios (`timerHistory.ts`) and compat rows.

## Where the port is NOT exact

1. **SQLite error text** comes from the bundled SQLite (3.47.0 in better-sqlite3
   11.5.0, a newer one in rusqlite 0.40). The messages the scenarios hit
   (`timer_owner_unavailable`, `timer_owner_mismatch`,
   `timer_entry_owned_by_another_session`, `today_ledger_owner_mismatch`, the
   UNIQUE failure of the rolled-back task switch) match; other SQLite error
   strings are not compared.
2. **Entries are typed.** `kind`, `source` and the enums follow core's `PARITY.md` 3: a row
   with an unknown enum value fails to read where TypeScript would carry it. Key order and unknown
   ENTRY keys are kept (above); what is not: unknown or reordered keys of a SEGMENT object (no
   released version ever wrote one: `Segment` is unchanged since 63eeba0), and a row that lacks a
   required key such as `endedAt` (it is written back as `null`; every released version wrote it).
3. **One connection.** The TypeScript opens four connections to `agent.db`; the
   timer stores share one `Arc<Mutex<Connection>>` (held for one call).
   `synchronous = FULL` and WAL are set by the entry store as before.
4. `listRecent(limit)` binds `limit` as an integer; a fractional limit is
   `datatype mismatch` as in SQLite, with this crate's message.
