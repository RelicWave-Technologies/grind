# timo-store parity notes: the non-timer persistence layer

Covers `activity_store`, `capture_store`, `lark_task_cache`, `preferences`,
`workspace_time_file`, `legacy_migration`, `paths`, `agent_db` (the timer tables live
under `src/timer/` and have their own notes). Merge into `PARITY.md` when the timer
notes land.

Sources: `legacy/agent/src/main/services/{activity/store.ts, capture/store.ts,
larkTaskCache.ts, preferences.ts, legacyMigration.ts, workspaceTime.ts (file part)}`.

## How it is proven

- `parity/src/gen/store*.ts` run the **real TypeScript classes** (`ActivityStore`,
  `ScreenshotStore`, `LarkTaskCache`, imported from `legacy/`; better-sqlite3 loads fine
  under plain node) over a seeded **operation sequence** per case: pre-seed SQL
  (legacy-shaped schemas missing the `ALTER` columns, half-migrated tables, tables the
  constructor cannot finish, damaged cache rows, a marker already present), then 1-45
  ops with fractional timestamps, unicode, huge/odd doubles, duplicate ids (UNIQUE
  failures), fractional `LIMIT`s (datatype mismatch), `DROP TABLE`, reboots (`reopen`) with
  a fresh injected `Date.now()`.
- Recorded per case: every op's return value or thrown message, then a dump of
  `sqlite_master` (schema text) and **every table, every column, with SQLite's own
  `typeof()`** so INTEGER-versus-REAL storage is part of the proof.
- `tests/fixtures_store_db.rs` replays the same sequence through the Rust stores on a
  shared-cache in-memory database (a keeper connection keeps it alive when a constructor
  fails and drops its connection, as the TypeScript's single `Database` survives) and
  requires the JavaScript text (`timo_core::js::ser`) of the result to be identical. Error
  messages are SQLite's own text on both sides.
- `preferences`, `workspaceTime`, `legacyMigration` import `electron`, so the generator
  runs **verbatim copies** of their pure functions (file and line cited in each
  generator): `coerce`/`ensureLoaded`/`getPreferences`/`patchFloatingBar`/
  `rememberLastLarkTask` and the `JSON.stringify(cache, null, 2)` text;
  `parsePersisted` (with the real `TimeZoneSchema` from `@grind/types` as the validator,
  its verdicts recorded in the input for the Rust closure); `migrateLegacyUserData` +
  `quarantineLegacyEntry`, run against a real temp directory, compared as a sorted tree
  dump. The Rust is held to those copies, so a drift in `legacy/` is not seen until
  the copies are refreshed.
- The TypeScript unit tests are ported 1:1 (`tests/ported_*.rs`).

## Exact by construction

- Every SQL statement is the TypeScript's text. Numbers are bound as `f64`, which is
  what better-sqlite3 does for anything that is not an int32; SQLite's column affinity
  then stores `1791133380000.0` as INTEGER and `1791133383891.2627` as REAL, as it does for
  the Electron agent (`captured_at`, the activity columns). Reads return `f64` (`Number`).
- `PRAGMA`s: this layer sets none. `rusqlite` installs the same 5 s busy timeout
  better-sqlite3 does (verified in both sources).
- Date.now() / clocks: the retry-cap repair's `Date.now()`, `pending`'s `now`, `markTerminalFailed`'s
  `failedAt`, the Lark cache's `fetchedAt` are arguments. No clock is read in this crate.
- Files: `preferences.json` is `JSON.stringify(cache, null, 2)` (no trailing newline, `null`
  for absent x/y, non-finite numbers `null`), `workspace-time.json` is
  `JSON.stringify({workspaceId,timeZone})`; both written temp (`<file>.<pid>.tmp`, mode
  `0600`) then renamed; the temp is removed on failure.
- `userData`: macOS `~/Library/Application Support/Timo`, Windows `%APPDATA%\Timo`
  (`productName`), as pure `user_data_dir_for(platform, env)`.

## Deliberate quirks copied

- `scrubActiveFields` builds no statement (and returns 0) when the policy forbids nothing.
- A column-add failure is swallowed whatever its cause, not only "duplicate column".
- `requeueOnce` marker `requeue:storage-outage-500` holds the changed-row count as text.
- `quarantineLegacyEntry`: when `<entry>.migrated-to-timo` already exists the TypeScript calls
  `fs.rmSync(file, {force: true})`, which throws `ERR_FS_EISDIR` on a directory (checked on
  node 22: `force` forgives only a missing path). So a leftover `screenshots/` directory is
  **not** removed and the failure is only logged. Copied (`remove_file_not_dir`), and the
  fixtures exercise it. Worth a post-cutover decision: it re-copies nothing but leaves the
  old directory behind.
- `migrateLegacyUserData` is not platform-gated; the **call site** is (`index.ts:211`,
  `process.platform === 'win32'`). The gate belongs to the Rust caller.
- A migration failure part-way (an unreadable file) aborts the remaining entries and boot goes on;
  entries already copied stay copied and quarantined.

## Where the port is NOT exact

1. **Out-of-range JSON numbers** (`1e999`) in `preferences.json` or a Lark cache row: JS
   `JSON.parse` gives `Infinity` and keeps the rest of the file; `serde_json` refuses the
   number, so the whole file becomes "unreadable" (defaults) and the cache row is skipped.
   Same for lone-surrogate escapes (`"\ud800"`). Only a hand-edited file can contain either;
   the generators do not produce them.
2. **`Number(text)` in a numeric column**: decimal literals and `Infinity` are read as JS does;
   hex/octal/binary text (`"0x10"`) reads as `NaN`. Nothing in this layer writes text into a
   numeric column.
3. **Lark task key order**: `replace` writes `guid, summary, completed, url?, due, createdAt,
   creatorId, creatorName, loggedMs, loggedTodayMs, loggedTotalMs` (the API's order, which is what
   Electron stored). Unknown keys carried in `extra` are re-written after those, in `serde_json::Map` order (by name
   unless `preserve_order` is unified in); JS keeps their original order. Readers are order-agnostic, so nothing observes it.
4. **`patchFloatingBar({x: undefined})`** (which makes `JSON.stringify` omit the key) is not
   representable: a field is absent, a number, or `None`. No caller does it (`floating.ts` passes
   `{x,y}`, `{visible}`, `{x:null,y:null}`).
5. **Migration copy**: symlinks inside a legacy directory are followed (copied as what they
   point at); directory mode bits are not copied (files keep theirs via `fs::copy`). Legacy
   directories hold only files the agent wrote.
6. **SQLite version**: Electron's better-sqlite3 11.5.0 embeds SQLite 3.47.0; `rusqlite`
   0.40.2 embeds 3.53.2. Every fixture (500 per store committed; 4000 per store, salt
   12345, run once and not committed) is identical across the two, including `SUM` over mixed
   INTEGER/REAL, but a future SQLite could change an edge the fixtures do not cover.
7. **`list` row types**: a Lark row whose `url` is not a string is returned with the value in
   `extra["url"]` (TypeScript returns it as `url`; serialised, the two are identical): `url` is the only
   field typed more narrowly than `isCachedTask` checks.
