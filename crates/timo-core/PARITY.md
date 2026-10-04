# timo-core parity notes

`timo-core` ports `packages/core/src` (`types`, `segments`, `clamp`,
`timerLedger`, `todayLedger`). The rule: the Rust must produce the same bytes as
the TypeScript. This file lists how that is proven, where the port is exact by
construction, every deliberate quirk copied from the TypeScript, and the few
places where it is **not** exact.

## How it is proven

- `parity/` (`@grind/parity`, run with tsx) calls the real TypeScript functions
  over hand-picked edge cases plus 500 seeded random cases per function and
  writes `tests/fixtures/<module>/<fn>.json`: `{fn, seed, cases:[{input, output}]}`,
  one case per line. A thrown error is recorded as `{"error": message}`.
- `pnpm --filter @grind/parity fixtures` regenerates them.
  `pnpm --filter @grind/parity check` regenerates in memory and exits 1 if any
  file differs, is missing, or is stale. (It does not rely on `git diff`, which
  cannot see untracked files.)
- Every case is also run under five time zones (UTC, Asia/Kolkata,
  America/New_York, Australia/Lord_Howe, Pacific/Apia). A case whose output
  changes with the zone is dropped: it read local time, which a pure port cannot
  reproduce (see "Dates").
- `cargo test -p timo-core` loads each fixture and requires the Rust output,
  serialized by `timo_core::js::ser::to_string`, to be **byte-identical** to the
  JSON text the TypeScript produced. There is no normalising step, so `5` vs
  `5.0`, `-0` vs `0`, number digits and key order are all checked by the
  comparison itself. On mismatch the case index, input, expected and actual are
  printed.
- The TypeScript unit tests are ported 1:1 (`tests/ported_*.rs`, same names in
  snake_case, `describe` as a module).
- Random generators draw from: fractional timestamps, overlapping/unsorted/
  zero-length/inverted/open-ended segments, several open segments, duplicate ids,
  equal timestamps, midnight and DST instants for New_York, London, Kolkata,
  Lord_Howe and Apia, negative and huge values up to +-2^53 and Date's +-8.64e15
  limit, ids that tie under `localeCompare`, and empty inputs.
- Soak runs done for this port (not committed): 20,000 random cases per function
  (seed salt 12345; 28,100 `localeCompare`, 20,545 `dateParse`) and 15,000 per
  function for segments, clamp, timerLedger, todayLedger, `dateParse` and
  `numberToString` (salt 987654321). All pass byte for byte. The first soak found
  the unsupported-vs-invalid ordering described under "Where the port is NOT
  exact" (fixed).
- Bigger dumps for ad-hoc soak runs: `PARITY_FIXTURE_ROOT=/some/dir
  PARITY_SALT=7 pnpm --filter @grind/parity fixtures -- --count 20000`, then
  `TIMO_FIXTURE_DIR=/some/dir cargo test -p timo-core`.

## Numbers

**Timestamps are `f64`, not `i64`.** The agent's timer clock is
`anchorServer + (performance.now() - anchorMono)`, so real rows hold fractional
milliseconds (`1791133383891.2627`, stored as SQLite REAL). Everything that is a
JavaScript number in the TypeScript is an `f64` in Rust: `startedAt`, `endedAt`,
`revision`, `at`, `now`, `skewMs`, window bounds and every total.

- **Same operations, same order.** Floating-point addition is not associative;
  `unionDuration` returns `total + end - start`, which JavaScript reads as
  `(total + end) - start`, and the Rust is written the same way. All `+`, `-`,
  `===` go through `js::number::{add, sub, strict_eq}` so the arithmetic lives in
  one module (the only one allowed float arithmetic and `as`).
- `Math.max/min/round/floor/ceil/trunc` and `%` are in `js::number` (NaN
  propagation, `+0` beats `-0`, `Math.round(-33.5) === -33`,
  `0.49999999999999994` rounds to 0). The ported code only uses `max` and `min`;
  the rest are there for the agent code that follows and are fixture-tested
  against the engine.
- `js::number::sort_cmp` is the comparator `(a, b) => a - b || tiebreak`: a
  difference of `0` or `NaN` falls through to the tiebreak.
- `i64_to_f64` / `f64_to_i64` are the checked conversions (exact or an error).
- **JSON.** `js::ser::to_string` is a serde serializer that writes what
  `JSON.stringify` writes: ECMAScript `Number::toString` through the `ryu-js`
  crate (shortest round-trip digits, `5` not `5.0`, exponent form only from 1e21
  or below 1e-6, `-0` as `0`), NaN and the infinities as `null`, strings quoted
  as `JSON.stringify` quotes them, declaration-order keys, no whitespace. Use it
  (not `serde_json::to_string`) for anything that must equal the TypeScript's
  JSON. `js/number_to_string.json` (725 tricky doubles) and
  `js/json_stringify_numbers.json` test it against the engine.
- **Parsing.** `serde_json` must run with `float_roundtrip` (set on the
  workspace dependency). Without it a long fractional timestamp can parse one ULP
  off V8, and that changes the sum.
- Inputs are finite numbers (JSON cannot carry NaN or Infinity). Outputs may be
  non-finite when a sum overflows; they serialize as `null` in both languages.
- A `-0` input is not generated: JSON text loses its sign.

## Quirks copied from the TypeScript (not fixed)

segments
1. `openSegment` and `closeTimeEntry` bump `revision` once from the *input*
   entry. The inner `closeOpenSegment` bump is discarded, so closing + opening is
   +1, not +2.
2. `recoverStaleEntry` closes with `closeReason: 'AGENT'`, never
   `'AGENT_RECOVERY'`.
3. `applyIdleDiscard`: if `resumeAt` is before the open segment's start (but not
   before `idleStartedAt`) it writes an `IDLE_TRIMMED` segment of negative length
   instead of throwing. The throw order is: entry closed, no open segment,
   `resumeAt < idleStartedAt`.
4. `applyIdleDiscard` replaces the *first* open segment even if it is not last
   (`splice(i, 1, ...)`), and `getOpenSegment` / `closeOpenSegment` also use the
   first open one.
5. `closeTimeEntry` on an already-ended entry returns it untouched even if it
   still has an open segment. It does not check that `at` is not before the
   previous segment's end when nothing was open.
6. `closeOpenSegment` with nothing open is a no-op (same revision).
7. `totalWorkedMs` only throws for an open *counted* segment (an open
   `IDLE_TRIMMED` is ignored) and counts a negative-length segment as 0.
8. `createTimeEntry` always writes `larkTaskGuid: null` for absent/null.

clamp
9. A segment with `endedAt <= startedAt` is dropped even when nothing was
   clamped; the note still says "dropped (zero-length after clamp)" and
   `adjusted` becomes true.
10. `entry.startedAt` is clamped on its own and not moved to the first surviving
    segment; `entry.endedAt` likewise.
11. A negative `skewMs` is treated as 0 (`Math.max(0, skewMs)`).

timerLedger
12. `typeof value === 'number'` is returned as is, with no validation; only
    strings and Dates are checked for NaN.
13. Segments are ordered by `startedAt` then `id.localeCompare`; `endedAt` does
    not take part. `userId` and `pauseReason` are not in the payload.
14. `revision ?? 0`, `larkTaskGuid ?? null`, `closeReason ?? null`.

todayLedger
15. Server entries are indexed with a `Map`, so a later duplicate id or client
    uuid replaces the earlier one; `consumedServerIds` is by id, so every server
    row sharing a consumed id is skipped.
16. A `synced` local row with no server match is flagged `SERVER_MISSING`; a
    pending one is not.
17. Order of decisions for a matched pair: equal revision and payload (the
    locally active entry wins), acknowledged correction, local newer (pending
    forced true), equal revision with different payload, otherwise server newer.
18. Overlap detection compares different entry ids only; an entry never
    overlaps itself. `conflicts` counts entries with at least one conflict.
19. An inverted window (`windowEnd < windowStart`) yields no intervals.

## Where the port is NOT exact

1. **`localeCompare` is locale-dependent in JavaScript; the port is not.**
   Sorting ties on `startedAt` falls back to `a.id.localeCompare(b.id)`, which in
   V8 follows the process locale (`cs`, `da`, `et`... tailor ASCII). The port
   uses the root collation (`icu_collator`, ICU4X), which is what `en-US` gives.
   8,600 pairs across ASCII, control characters, Latin-1, Greek, Cyrillic, CJK,
   emoji and canonically-equivalent sequences matched Node 22 (ICU 78) exactly.
   Real ids are ULIDs (ASCII), so a tie that differs by locale needs two ids that
   collate differently under a tailoring.
2. **`new Date(string)` is only ported for ISO 8601 shapes.** Supported:
   `YYYY`, `YYYY-MM`, `YYYY-MM-DD` (UTC), and `<date>T<HH:mm[:ss[.f+]]>` followed
   by `Z` or `+HH:mm`/`-HH:mm`; years `YYYY` or `+/-YYYYYY`; V8's quirks inside
   that grammar are reproduced (Feb 30 rolls into March, `24:00:00` is valid,
   fraction truncated to milliseconds, offsets up to `+23:59`, TimeClip at
   +-8.64e15, `-000000` invalid). Everything else is
   `CoreError::UnsupportedTimerTimestamp`, **not** a guess: V8's legacy parser
   (`"hello 2020"`, `"Jan 1 2020"`, lower-case `t`/`z`, a space instead of `T`,
   `+0530`, `date-only+offset`, `-000000-01-01`) and any date-time without an
   offset (V8 reads the machine's time zone). The empty string is
   `InvalidTimerTimestamp`. In `canonicalTimerEntryPayload` an unsupported string
   is reported only after every other timestamp has been read, so an entry that
   also holds an invalid one still gives `invalid_timer_timestamp` like the
   TypeScript (found by the soak run below). Production strings are `toISOString()` output, which
   is inside the supported set.
3. **Inputs must follow the TypeScript types.** `kind`, `source`, `pauseReason`,
   `closeReason` and `syncState` are enums, so an out-of-set string is a
   deserialization error where TypeScript would carry it through. Properties not
   in the types are dropped (TypeScript's `{...entry}` would copy them). A
   missing `pauseReason`/`closeReason`/`endedAt` is read as `null`. `larkTaskGuid`
   keeps the absent / `null` / string distinction on `TimeEntry`; elsewhere
   absent and `null` are the same, as in the TypeScript logic.
4. **Strings are valid UTF-8.** JSON with lone surrogate escapes (`\ud800`)
   cannot be read into a Rust `String`; the generators never produce them.
5. **`SegmentError` is `CoreError::Segment(message)`.** Only the message is
   compared; the error class name is not recorded.
6. `todayLedger.test.ts` hashes with SHA-256; the Rust port of that test uses
   the payload as the opaque hash (the reconciler only compares it for equality).
   The parity fixtures use real SHA-256 hex.
