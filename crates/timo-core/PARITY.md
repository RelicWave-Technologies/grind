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

## Locale (`localeCompare`)

`'01ARZ3NDEKTSV4RRFFQ69G50CH'.localeCompare('...CJ')` is `-1` under `en-US` and `+1` under `cs`
(the Czech "ch" is one letter, after "h"), and `canonicalTimerEntryPayload` sorts segments that tie on
`startedAt` with it, so the hash an acknowledgement is compared with depends on the locale.

**Which locale the legacy app uses: measured on the real Electron 33.2.0 binary (macOS arm64), main
process, `app.getLocale()` against `Intl.Collator().resolvedOptions().locale` and the ULID pair above:**

| environment | `app.getLocale()` | default locale of `localeCompare` | CH vs CJ |
|---|---|---|---|
| none (`env -i`, as launched from Finder), `LANG=C.UTF-8`, `LANG=POSIX` | `en-GB` (the OS) | `en-US` | -1 |
| `LANG=cs_CZ.UTF-8` | `en-GB` | `cs-CZ` | +1 |
| `LC_ALL=en_US.UTF-8` and `LANG=cs_CZ.UTF-8` | | `en-US` | -1 |
| `LC_MESSAGES=cs_CZ.UTF-8` and `LANG=en_US.UTF-8` | | `cs-CZ` | +1 |
| `LC_COLLATE=cs_CZ.UTF-8` and `LANG=en_US.UTF-8` | | `en-US` (ignored) | -1 |
| `-AppleLanguages (cs)` (macOS preferred language `cs`), `--lang=cs` | `cs` | `en-US` | -1 |

So the default is ICU's own, from the POSIX environment (`LC_ALL`, else `LC_MESSAGES`, else `LANG`;
`C`/`POSIX`/nothing is `en-US`), and Chromium does not copy `app.getLocale()` or the macOS
preferred languages into V8. `posix_locale_tag` is that derivation; the shell reads the three
variables and passes the tag to `set_default_locale` once at start. A packaged app started from
Finder or the Dock has no `LANG`, so it collates as `en-US`.
**Not measured: Windows.** There ICU reads the user's regional format (`GetUserDefaultLocaleName`);
the shell would pass that tag. This is argued from ICU's source, not observed.
A keyword in the environment (`es_ES@collation=traditional`) resolves to the plain locale (`es-ES`)
on Electron; the keyword is dropped here too, and whether V8 still applies it to the collator is
not known.

**What the Rust does for a locale:** `collator_for(tag)` over `icu_collator` 1.5.0 (ICU4X 1.5, the CLDR 44
generation: that of Electron 33's ICU 74.2; the 2.3.1 data tried first collated as Node 22's ICU 78
(CLDR 48) does, which tailors Hawaiian, Nynorsk, Welsh, ... where Electron's data does not). Two things ICU does that the data lookup does not are
done explicitly: Traditional Chinese (`zh-TW`/`-HK`/`-MO`, script `Hant`) collates by stroke, and
the languages below collate as the root.
**Chromium ships a trimmed ICU data file.** On Electron 33.2.0 these languages, which CLDR tailors,
collate exactly as `en-US` over all 9,316 pairs of 137 probe strings (ASCII digraphs, `aa`, accents,
nine scripts): `as az be bs chr cy dsb ee fo gl hsb hy ig is ka kk kok ku ky mk mn mt ne nn om or pa
ps si sq tk to ug uz wo` (`ELECTRON_UNTAILORED`). A complete-CLDR runtime (Node 22, ICU 78.2)
differs for them, so the Electron snapshot, not Node, is the oracle there.

**Proof.** (1) `tests/data/locale_electron.json`, written by `parity/src/electronLocale.mjs` under
Electron 33.2.0 (`ELECTRON_RUN_AS_NODE=1 <binary> src/electronLocale.mjs ...`): 115 locales x 9,316
pairs; `locale_electron_snapshot.rs` requires every one. One pair is known to differ and is listed
exactly in the test: `lv-LV`, `"y"` vs `"ĳ"` (the `ĳ` ligature, not an id character). (2)
`fixtures/locale/{locale_compare_in,canonical_payload_in}.json`: the real `localeCompare` and
`canonicalTimerEntryPayload`, one child process per locale with that locale's environment, 41 locales
over ids chosen to hit the tailorings (digraphs, `aa`, `y`/`z`/`v`/`w`, accents); regenerating them
under Electron's ICU (`PARITY_LOCALE_RUNTIME=<binary>`) is byte-identical to the Node-generated
files. Locales the trimmed ICU does not tailor are not in them (they are in (1)).
**Residual:** a locale not in the snapshot (about 200 CLDR locales exist; 115 were measured, covering
every language ICU4X tailors) falls back through ICU4X's chain, which can differ from Electron's
for a language Chromium trimmed that is not listed. `reconcile_today_ledger` also compares ids with
the process locale and is covered by the root fixtures only.

## Where the port is NOT exact

1. **`localeCompare` follows the ICU default locale of the process; the port follows the one the
   shell gives it (see "Locale" below).** Sorting ties on `startedAt` falls back to
   `a.id.localeCompare(b.id)`. Until the shell calls `js::collate::set_default_locale` the root
   collation (`en-US`) is used, which is what a process with no locale environment gets.
   8,600 pairs across ASCII, control characters, Latin-1, Greek, Cyrillic, CJK, emoji and
   canonically-equivalent sequences matched Node 22 (ICU 78) exactly under the root.
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

# Business day, time zones, shift reducers, agent config

Modules `tz/` (`packages/types/src/timezone.ts`), `workspace_time.rs`
(`services/workspaceTime.ts`), `shift/` (`shift/decide.ts`, `shift/untracked.ts`)
and `agent_config.rs` + `agent_config_response.rs` (`services/agentConfig.ts`,
`AgentConfigResponse` in `packages/types/src/agent.ts`). Which worked time counts
as "today" is decided here and feeds pay, so the oracle is the app that ships:
`Intl` on **Electron 33.2.0**.

## Versions (what the time zone answers are only as good as)

| Runtime | Node | ICU / CLDR | tzdata | How it was found |
|---|---|---|---|---|
| **Electron 33.2.0** (the legacy app; Chromium 130.0.6723.118, V8 13.0.245.18) | 20.18.0 | 74.2 / 44.1 | **2024a** | ran the cached `electron-v33.2.0-darwin-arm64` binary with `ELECTRON_RUN_AS_NODE=1` and read `process.versions`; the ICU data file in the app (`icudtl.dat`) carries the version string `2024a` and no other; behaviour agrees (`EST` is a fixed zone, `America/Coyhaique` is rejected, `Asia/Almaty` is +05 since 2024-03) |
| **Harness Node on this machine** (`~/.local/bin/node`) | **22.23.1** | 78.2 / 48.0 | **2026a** | `process.versions`. The repo says Node 20.18 (`.nvmrc`, `engines`); the installed Node is not 20.18 |
| **Rust** | n/a | n/a | **2024a** | `jiff-tzdb =0.1.0` (published 2024-07-22, before tzdata 2024b). Checked, not assumed: its offsets equal Electron's for all 641 ids over 1970-2100 (the 6 `SystemV/*DT` ids needed their own model, below) |

`jiff-tzdb` is only the data. The `jiff` crate is not used: its Windows-only
`jiff-tzdb-platform` needs `jiff-tzdb >= 0.1.4` and Cargo.lock holds every
target, so `=0.1.0` cannot resolve beside it. `tz/tzif.rs` and `tz/posix.rs` read
the TZif files and POSIX footer rules instead (the footers are what make 2038 and
2100 work), about 350 lines, held to Electron by the fixtures below.

**Bumping the data is a decision, not a refactor.** A newer `jiff-tzdb` makes the
Rust app agree with today's tz rules and disagree with what Electron computed;
`tests/tz_electron_snapshot.rs` fails the day anyone does it.

## Which ids are valid

Validity is Electron's ICU, not IANA's list: `isValidTimeZone` is "does
`Intl.DateTimeFormat` throw". Reproduced, and compared against Electron for every
id it accepts (639 in the fixtures plus 2 below) and 2,459 variants (lower, upper,
mixed case, mutated, offset forms):

- every tzdata 2024a zone and link, case-insensitively (ASCII only: `Asia/Kolkata` is rejected);
- ICU-only ids tzdata 2024a does not have (`zone.rs::ICU_ONLY`): the Java
  three-letter ids (`IST` is `Asia/Calcutta`, `PST`, `CST`... ), `Canada/East-Saskatchewan`,
  `US/Pacific-New`, `SystemV/AST4` etc. The targets are what Electron's
  `resolvedOptions().timeZone` says, confirmed by the offset tables;
- offset ids `+HH`, `+HHMM`, `+HH:MM` with `+`, `-` or U+2212, hours <= 23, minutes <= 59 (`-00:00` is `+00:00`);
- not valid: `Z`, `GMT+5`, `UTC+05:00`, `+5`, `+24:00`, `Etc/GMT+13`, anything with a space or newline.
- `TimeZoneSchema` trims with JavaScript's whitespace set (U+FEFF yes, U+0085 no), then 1..80 UTF-16 units.

The `SystemV/*DT` ids (six of them) are not in tzdata 2024a at all. ICU gives them
the 1967 US rule (last Sunday of April to last Sunday of October) in **every** year
from 1902 on, with two exceptions (1974 ran from Jan 6 to Nov 24, 1975 started Feb 23).
`zone.rs::system_v_dst` rebuilds exactly that from Electron's answers; before 1902 they are on standard time.

## Disagreements between Electron (tzdata 2024a) and the harness Node (tzdata 2026a)

Found by dumping every id's offset-change table for 1970-2100 under both
runtimes. Two ids differ in validity, 23 in offsets; nothing else differs.
**Rust follows Electron on all of them** (`tests/tz_electron_snapshot.rs` checks
Rust against a table recorded from Electron by `parity/src/electronDrift.mjs`).
They are left out of the golden fixtures (`parity/src/gen/tzIds.ts`:
`VALIDITY_DRIFT`, `OFFSET_DRIFT`) so the fixtures come out byte for byte the same
under Electron and under Node, which is verified (see "How it is proven").

| id | Electron 33.2.0 (tzdata 2024a) | Node 22 (tzdata 2026a) | first difference (UTC) |
|---|---|---|---|
| `Factory` | valid | rejected | any |
| `America/Coyhaique` | rejected (the zone is new in 2025b) | valid | any |
| `America/Asuncion` | keeps its yearly DST (-04 / -03) | -03 all year (Paraguay, Oct 2024, tzdata 2025a) | 2025-03-23 03:00 |
| `Europe/Chisinau`, `Europe/Tiraspol` | DST changes at 00:00 UTC | at 01:00 UTC | 2022-03-27, every year after |
| `America/Tijuana`, `America/Ensenada`, `America/Santa_Isabel`, `Mexico/BajaNorte` | DST rule differs in the 1970s | | 1970-04-26 / 1976-04-25 |
| `America/Bahia_Banderas`, `America/Hermosillo`, `America/Mazatlan`, `Mexico/BajaSur` | standard offset at 1970-01-01 differs (-08 vs -07) | | 1970-01-01 |
| `America/Cancun`, `America/Merida` | 1981 change on another day | | 1981-12-23 |
| `Asia/Choibalsan`, `Asia/Manila`, `Asia/Tehran`, `Iran` | late-1970s history differs | | 1977-1983 |
| `Atlantic/Azores`, `Atlantic/Madeira`, `Europe/Lisbon`, `Portugal`, `EET`, `WET` | 1970s-1980s history differs | | 1970-01-01 .. 1982 |

Only `America/Asuncion` and the two Moldova ids differ in a year the product runs
in. **Real-world note:** Paraguay's government made -03 permanent in Oct 2024;
Electron 33's data does not know, so a legacy agent computes Asuncion's business
day an hour off from 2025-03-23 whenever the server says `America/Asuncion`. The
Rust port reproduces that, exactly. Moving to current tzdata (and so away from
Electron's answer) is a post-cutover decision.

## How it is proven

- **Fixtures** (`parity/src/gen/{tz,shift,agentConfig,workspaceTime}.ts` -> `tests/fixtures/{tz,shift,agentConfig}/`),
  byte for byte, ~9.7 MB, regenerated by `pnpm --filter @grind/parity fixtures`
  or in isolation, without the other generators, by `src/runIcu.ts [--services] [--check]`:
  - `tz/isValidTimeZone` (2,459), `tz/timeZoneSchema` (1,758);
  - `tz/zonedDateTimeParts` (5,444), `tz/dateKeyInTimeZone` (5,444): around **every**
    offset change 2015-2036 of 65 zones (UTC, Etc/GMT+-, Kolkata, Kathmandu, Kabul,
    Yangon, Tehran, Lord_Howe, Chatham, Apia, Kiritimati, Sao_Paulo, Havana,
    Santiago, Casablanca, St_Johns, Dublin, Troll, Cairo, Gaza, Nuuk, Norfolk,
    aliases `US/Eastern`, `IST`, `EST`, `+05:30`...), plus 500 random;
  - `tz/possibleInstantsForZonedDateTime` (5,494: 2,890 with one answer, 1,220 with two, 1,224 with none, 160 errors),
    `tz/instantForZonedDateTime` (5,494, 1,372 errors: gaps and bad parts): the wall clock either side of every change;
  - `tz/localDayWindowInTimeZone` (4,409; 340 `null`): the dates around every change, malformed dates, years 0-99;
  - `tz/zonedDateTimePartsWide` (836): eight zones at Date's limits (+-8.64e15 ms), year 1, year -1, 1900, 9999/10000, the Gregorian cut-over;
  - `tz/offsetTransitions` (1,116): **the whole offset history 1970-2100 of every one of the 616 ids**, found by stepping 9 days and bisecting to the second (58,349 transitions);
  - `tz/medianMinute` (523), `tz/workspaceTimeScenario` (539: the real service, with its file, over `init/apply/clear/session/context` sequences);
  - `shift/*` (10 functions, ~5,100 cases): random schedules (valid, overnight, malformed `HH:MM`), buffers (negative, fractional), states, `now` on the window edges and around DST changes in 20 zones; whole-day reducer sequences wired as `ShiftMonitor` wires them;
  - `agentConfig/agentConfigResponse` (663), `agentConfig/agentConfigRefresh` (673: the real `agentConfig.ts` over 1-4 server responses, locked and unlocked env).
- **Run under Electron.** `ELECTRON_RUN_AS_NODE=1 <Electron 33.2.0> ../node_modules/tsx/dist/cli.mjs src/runIcu.ts --check`
  regenerates the `tz` and `shift` fixtures inside Electron 33.2.0 (ICU 74.2, tzdata 2024a)
  and finds **all 20 byte-identical** to the committed ones, which Node 22.23.1 (ICU 78.2, tzdata 2026a) produced.
  So the Rust test (against these files) is a test against Electron.
- **Soak (not committed).** `PARITY_SALT=12345 ... runIcu.ts --count 4000` **under Electron 33.2.0** wrote
  67,977 `tz` and 40,162 `shift` cases (31 MB, new random inputs; the hand-picked ones are the same), and
  `TIMO_FIXTURE_DIR=<dir> cargo test -p timo-core` passes every one. The two service generators
  (`--services-only --count 3000`, Node 22) wrote 3,173 + 3,163 + 3,033 cases and also pass.
  The first run of the offset tables found the six `SystemV/*DT` ids (fixed by modelling them, above); nothing else failed.
- **Ported TS tests, 1:1:** `ported_shift_decide.rs` (21), `ported_shift_untracked.rs` (17),
  `ported_workspace_time.rs` (4), `ported_agent_config.rs` (2).
  `packages/types` has **no** test for `timezone.ts`; `tests/tz_units.rs` (9) pins
  facts read from Electron (23/24/25-hour days, the first occurrence of a repeated hour, midnight-less days).
- The two `agentConfig.test.ts` and four `workspaceTime.test.ts` tests drive services
  with files, tokens and promises; what is ported is every decision they observe
  (single-flight plan, session check, which zone and workspace are applied,
  restore only for the same workspace). The async glue is the app crate's.

## Quirks copied (not fixed)

- `dateKeyInTimeZone` does not pad the year: year 10000 is `10000-01-01`, year 900 would be `900-01-01`; `localDayWindowInTimeZone` then returns `null` (its regex wants four digits).
- `utcMillis` reads years 0-99 as 1900-1999 (`Date.UTC`), so the round trip fails and `instantForZonedDateTime` throws `invalid_local_time` there.
- `Intl` prints the era year without an era: year 0 is `1`, year -1 is `2`.
- A zone whose midnight does not exist on a day (Havana, Apia 2011-12-30, any zone that springs forward at 00:00) has **no business day** that day: `localDayWindowInTimeZone` is `null`, `contextAt` is "unavailable", worked time is 0.
- The fall-back hour resolves to the **earlier** occurrence; a spring-forward time is an error.
- `tickShiftMonitor`'s window is inclusive at both ends; an overnight shift (end <= start) has no window in `resolveShiftWindow`; a shift time that does not exist today (02:30 on a spring-forward day) is "no start today"; `HH:MM` is read with `parseInt` (`"9"` is 09:00, `"09:30:15"` is 09:30, `"ab:cd"` is nothing).
- `tickUntrackedNudge`: `attentionBusy` clears `prompting` but **not** `activeSince`, so a non-idle prompt banks the streak, contrary to the comment above it.
- `{...state, ...}` keeps the input's key order, so state objects must be built in the order `ackedFor, snoozedUntil, prompting` / `activeSince, snoozedUntil, prompting` (the Rust structs are).
- `snooze`/`nudge` take a `Date`: beyond +-8.64e15 ms it is invalid and `snoozedUntil` is `NaN`, which serializes as `null`.
- `AgentConfigResponse` is all or nothing; a default fills only an **absent** key; an explicit `null` fails everywhere except `idleWarningSeconds`; `workspaceTimezone` is trimmed by the schema and returned trimmed; `captureTitles/Urls` count only when `captureApps` is on; the idle warning counts only when it is strictly below the idle threshold in effect (the env-locked one if locked).
- `refreshAgentConfig` single-flights on `` `${userId}:${workspaceId}` `` (ids containing `:` collide, as in the TypeScript).

## Where the port is NOT exact

1. **tzdata after 2024a** (see above): deliberately Electron's, not today's. Nothing here is a bug
   in the port; it is a property of the oracle.
2. **Not tested before 1970 for the 616 ids** (the offset tables start at 1970-01-01) and not after 2100. Covered
   instead by 836 wide-range cases in eight zones (all match, including pre-1900 local mean time and the Gregorian
   cut-over) and by POSIX footers, which are exact by construction after the last explicit transition. A
   disagreement in an unusual zone before 1970 is possible and would not be caught.
3. **`SystemV/*DT`** before 1902 and between 1895 and 1977 outside the probed years: modelled from
   what Electron answered (see above); never a real workspace zone.
4. **Parts are `i64`.** `ZonedDateTimeParts` fields that the TypeScript would accept as fractional or `NaN`
   are not representable; the callers (`localDayWindowInTimeZone`, the shift code) only produce integers.
   Inputs are numbers (a `Date`'s time value): strings are the caller's job through `js::date::parse`.
5. **Caches are not ported** (zone validity 128 entries, formatters 128, day windows 512, all FIFO):
   every function is pure, so eviction order cannot change an answer.
6. **`parsePersisted`** takes the two fields already read from the JSON file (`None` for anything that is
   not a string); reading, parsing and writing `workspace-time.json`, the token reads and the listeners are the
   app crate's. A number JSON parser readers disagree on (`1e400`) in an *unknown* key of an agent-config
   response fails to parse in Rust and is `Infinity` (accepted) in JavaScript.
7. **The harness depends on the generating Node's ICU** for ids and instants not in the lists above. Any
   future tzdata that moves an id's offsets in 1970-2100 will show as `changed tz/offset_transitions.json`
   under `pnpm check`: add the id to `OFFSET_DRIFT` and re-record `tests/data/tz_electron_drift.json`
   with `electronDrift.mjs`. `.nvmrc` says Node 20.18, but this machine's Node is 22.23.1.

# Activity, idle, prompts, capture, updates, launch-at-login

Wave-2 ports of the pure and stateful-pure services of `legacy/agent/src/main`:
`activity/{aggregator,minuteSealer,percent,activeWindow}`, `idle/{decide,monitor}`,
`trackingAttention`, `promptReachability`, `trackingReadiness`,
`floatingBarVisibility`, `quitCleanup`, `launchAtLogin`, `moveToApplications`,
`heartbeatPayload`, `trayPresentation`, `updates/state`, `capture/{scheduler,
retention,asyncLru}`, `activityWindowForShot` (`capture/index.ts`), the uploader
policy functions, `windows/floatingBarPosition` and the placement helpers of
`windows/overlay.ts` (which `apps/desktop/src-tauri/src/placement.rs` now calls).

## How it is proven (this section)

- 210 TypeScript unit tests ported 1:1 (`tests/ported_{activity,idle,
  tracking_attention,tracking_readiness,quit_cleanup,launch_at_login,capture,
  desktop_small}.rs`, same names in snake_case): aggregator 13, minuteSealer 9,
  percent 6, activeWindow 15, idle decide 6, IdleMonitor 8, trackingAttention 31,
  promptReachability 9, trackingReadiness 9, floatingBarVisibility 3,
  quitCleanup 6, launchAtLogin 22, moveToApplications 4, heartbeatPayload 8,
  trayPresentation 3, updates/state 7, scheduler 7, retention 7, asyncLru 3,
  activityWindowForShot 6, uploader policy 7, floatingBarPosition 12, overlay
  placement 9.
- 55 golden fixture files, 30,849 cases, dumped from the real TypeScript
  (`parity/src/gen/{activity,idle,attention,capture,desktopSmall,updates,
  readiness,quit,winPath,launch,jsMath}.ts`) and replayed byte for byte.
  - Stateless functions: edge cases plus seeded random inputs.
  - Stateful services (aggregator, MinuteSealer, ActiveWindowTracker,
    IdleMonitor, the attention coordinator, the readiness service, the quit
    runner, launch-at-login, AsyncLru, the update reducer, the visibility
    policy): seeded random EVENT SEQUENCES with fractional timestamps. The state
    and every outside effect (host calls, timers, log lines, app calls) after
    EVERY event is recorded and compared.
  - The async ones (IdleMonitor, coordinator, readiness, quit runner, AsyncLru,
    moveToApplications) run their scenarios ahead of time (top-level await in the
    generator, `gen/asyncSpec.ts`) because the recorder's `call` is synchronous;
    the inputs come from the same seed the recorder derives.
  - The real Electron-bound modules load under plain Node through a resolution
    hook (`parity/src/legacyStubs/hooks.mjs`): `electron`, `env`, `logger` and
    the neighbours listed in its table are replaced by small stubs, everything
    else is the shipped code. Modules with module-level memos (`trackingReadiness`,
    `launchAtLogin`) are loaded as a fresh instance per scenario.
- `js::math` (`Math.hypot`, `x ** 2`, `*`, `/`, `Math.sqrt`), `js::iso`
  (`toISOString`), `js::string` (`trim`) and `js::path_win32` (`path.win32`
  normalize/basename/dirname/join) have their own fixtures against Node.
- Before the port: `x ** 2` equals `x * x` and `Math.hypot(x, y)` equals the Kahan
  algorithm below in 20,000,000 random pairs each on Node 22.23.1.

## Numbers (this section)

- **`Math.hypot` is V8's algorithm, not libm's**: `max = max(|v|)`, then
  `sqrt(sum((|v|/max)^2) with Kahan compensation) * max`; infinity beats NaN beats
  the rest; all zeros give 0. Mouse distances are summed from it and then
  `Math.round`ed into the stored sample, so a one-bit difference would show.
  `js::math::hypot` reproduces it; 1,400 random-bit pairs and 508 n-ary cases
  match.
- Every counter in a sample (`keystrokes`, `clicks`, ...) is an `f64` and grows
  with `add(x, 1.0)`: the TypeScript never overflows an integer either.
- `Math.floor(ms / 60_000) * 60_000` is done in floating point on the fractional
  clock, exactly as written (the bucket label of a fractional minute is checked).
- Dates go through `js::iso::to_iso_string` (`new Date(x).toISOString()`:
  truncates toward zero, `RangeError: Invalid time value` outside +-8.64e15).

## Quirks copied (this section)

activity
1. **The `activeWindow` tally key is `app + U+0001 + bundle`**, not "no
   separator" as `inventory.md` SC-65 says (the separator is an invisible control
   character in the source). `("ab", "c")` and `("a", "bc")` do NOT collide;
   names that themselves contain U+0001 do, and the collision is kept.
2. Ties go to the first key inserted (strict `>`); the winner's LAST observation
   supplies title and url; a slice counts only with a positive length and a
   non-empty `app` or `appBundle` (an empty string is falsy).
3. `MinuteSealer`: a bucket at or below `lastEmittedBucket` is flushed and
   dropped (data loss by design, protects the server's overwrite-by-bucket); an
   empty bucket is dropped; `setRecording(true, id)` replaces the entry id,
   `setRecording(false, ...)` keeps it. The label is the minute-floor of the
   PREVIOUS tick, so a late or early tick pair can collide on a label and drop one.
4. `ActivityAggregator.isEmpty` needs distance 0 AND no recorded speed; a move with
   `dt <= 0` adds distance but records no speed; `pathStraightness` needs distance
   greater than 0; the distance is `Math.round`ed (halves up) after summing.
5. `coefficientOfVariation` is the POPULATION CV and is `null` when the mean is
   exactly 0 (a mean of `-0` too). `-0` results are written as `0` (the recorder
   refuses `-0`; the JSON text is identical).
6. `activityPercent` guards `minutes <= 0` only; NaN minutes pass the guard and
   come out as `null` after JSON.

idle
7. `shouldPromptIdle` is unused in production; ported because it is exported.
8. `IdleMonitor`: `isProtected` is never `true` in production; `noteActivity` only
   cancels a warning; the continuation after an awaited handler runs on whatever
   state other events left (a warning accepted after `noteActivity` still arms its
   timer; `onIdle` accepted after `resume()` sets `IDLE_PROMPT`); a rejected or
   throwing `onIdle` leaves `IDLE_PENDING` and is retried on every poll; the
   re-armed deadline is the one captured when the warning was raised.

attention and readiness
9. `floatBelief()` swallows a throw as `false`; with no logger the meta (and so
   `host.onTop()`) is never evaluated. `clear('')` behaves as `clear()`.
   `releaseUnreachable` stops polling, releases, hides and publishes `NONE`, in that
   order; the poll answer of a stale `yield` is ignored (identity of the predicate).
10. Readiness: `checkedAt` is read when the result is BUILT, after the probe;
    the probe memo is read again after the await, so `noteScreenHealth` or
    `invalidateScreenProbe` landing in between is seen; a non-ready verdict is
    logged once per distinct shape. (TypeScript keeps that memo in a MODULE
    variable shared by every service instance; Rust keeps it per service. Log only.)

quit cleanup
11. A step that times out is abandoned, not cancelled: its late result is ignored
    but `clearTimer` is still called on it; an activity failure does not stop the
    run; a timer-step failure skips only the sync step; preferences failures warn
    and the run goes on; log-flush failures are swallowed; `invalidate()` only
    clears `completed`; a second `run()` while one is in flight joins it.

launch at login
12. `isInApplicationsFolder()` is outside every `try`; the first `try` of
    `cleanupWindowsItems` swallows a throw and ENDS its loop, while the legacy-item
    `setLoginItemSettings` calls after it are not guarded (a throw escapes `repair`);
    `registerAndVerify` catches everything including the inner `inspect()`; the
    Windows item identity compares name and normalised path only, never `args`; the
    verdict log is deduplicated on `state|branch|fields` (module-level in TypeScript,
    per service here); `String(err)` text of an `Error` is `Error: message`.

updates and capture
13. `Number("99999999999999999999")` loses precision and the loss is kept; equal
    numeric prerelease identifiers with different spellings (`01` vs `1`) fall
    through to the next identifier; a shorter prerelease is lower.
14. `planScreenshotRetention` counts `expired` / `danglingRows` / `orphanFiles` per
    occurrence but de-duplicates the delete lists (`Set`), keeping insertion order.
15. Retry delay uses `2 ** max(0, n - 1)`, capped at one hour, with the random
    fraction applied to `capped - 60 s`; `rng` is only called when the cap is above
    the floor.
16. `trayMenuTitleForElapsed` trims with JavaScript's whitespace set (strips
    U+FEFF, keeps U+0085).

## Where the port is NOT exact (this section)

1. **`2 ** n` for a fractional `n`** uses `f64::powf`, not V8's `pow`. Whole
   exponents (every attempt count the agent produces) are exact powers of two.
2. **`body.slice(0, 200)` in `CloudinaryUploadError`** counts UTF-16 units; when the
   cut falls inside a surrogate pair JavaScript keeps a lone surrogate, which a
   Rust `String` cannot hold, so the half pair is dropped. The fixtures never cut a pair.
3. **`toLowerCase`** is Rust's Unicode tables against ICU 78 in the harness Node
   (519 fixture cases incl. final sigma, `İ`, Georgian, ligatures); a future Unicode
   release could differ.
4. **`path.win32`** follows the algorithm of Node 20.18 (Electron 33.2's Node,
   which the legacy agent ran), including the colon guard in `normalize`. The
   harness Node (22.23.1; the repo asks for 20.18 but only 22/24 are installed here)
   has a 2025 change: `\\\\?\\...` and `\\\\.\\...` are device roots and reserved device
   names are recognised. The port does NOT have that. The fixtures leave out inputs
   that start with a device root, and a soak run found exactly that difference
   (`join(['\\\\?', 'a:b'])`). A Windows `execPath` is never such a path in the field;
   if it were, the legacy agent's answer would be the older one this port gives.
5. **Promises become explicit events.** `IdleMonitor`, the coordinator's resume
   check, readiness `inspect`, `QuitCleanupRunner`, `AsyncLru` and
   `moveToApplications` await real promises in TypeScript. Here each await is a
   method call the host makes when the awaited thing ends, so the interleavings the
   fixtures drive (an event between a request and its answer) are proven, but the
   microtask hop count is not: `QuitCleanupRunner` sets `completed` and clears
   `inFlight` in one step where TypeScript takes two promise hops.
6. **Not ported (not in scope or dead):** `IdleMonitor.start()` and its interval,
   `IDLE_POLL_MS` (`env.ts`), the OS-bound singletons (`getTimerService`,
   `attentionHost`, `getLaunchAtLoginService`), `registerGracefulQuitHandler`'s
   `app.on` wiring (its decision is `before_quit_decision`), and `isInApplicationsFolder`
   / `getTimer` throwing outside a `try` (the Rust traits cannot throw there).
7. `timo_desktop::placement` keeps its whole-pixel `i64` types and converts to the
   `f64` of `timo_core::placement` and back; the half-pixel rounding therefore comes
   from `Math.round` (fixture-checked) instead of the old doubling trick. Needed one
   line in `apps/desktop/src-tauri/Cargo.toml` (`timo-core` dependency).
