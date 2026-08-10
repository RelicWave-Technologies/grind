/**
 * Server-aligned wall clock for anything the server will judge.
 *
 * The agent used to stamp timer timestamps straight from the laptop's wall
 * clock. The server refuses to trust that — `clampEntryToServerClock` caps every
 * uploaded timestamp at `serverNow + 2min` — so on a machine whose clock runs
 * more than two minutes fast, EVERY sync was clamped. Worse, the clamp collapses
 * a segment's start and end onto the same ceiling, and a segment whose end is
 * `<= start` is dropped outright, so real worked time disappeared on every
 * upload while the user just saw "Timo corrected this timer…" over and over.
 *
 * Clamping is the correct server behaviour (a fast client clock over-credits,
 * which is the dangerous direction). The bug is on this side: we should be
 * stamping in the server's frame of reference.
 *
 * ## Why this is monotonic-driven rather than `Date.now() + offset`
 *
 * The obvious fix — add an offset to `Date.now()` and clamp the result so it
 * never goes backwards — is worse than the bug. Clamping does not slow a
 * backwards correction down, it *stops the clock*: on a device ten minutes
 * fast, `now()` returns the same instant for ten real minutes, a running timer
 * accrues nothing, and the user loses exactly the time the fix was meant to
 * save.
 *
 * Slewing instead of stopping cannot rescue it either. The kernel's slew
 * ceiling is 500 ppm, which takes ~33 minutes to absorb one second; a
 * ten-minute correction would take about a fortnight. NTP's own answer to a
 * large offset is to *step* the clock and require applications to measure
 * durations against a monotonic source instead. Google's leap smear only works
 * because it spreads a single second across a whole day.
 *
 * So this module does what a trusted-time client (e.g. Lyft's Kronos) does:
 * hold an **anchor** pairing one known server instant with one monotonic
 * reading, and derive now from the monotonic delta since that anchor:
 *
 *     now = anchorServer + (monotonic() - anchorMonotonic)
 *
 * `performance.now()` is unaffected by wall-clock edits, DST and NTP steps, so
 * between anchors the clock advances at exactly real rate — it can never
 * freeze, never run backwards, and never be moved by a user editing the
 * device clock.
 *
 * ## Why corrections wait while a timer is running
 *
 * Re-anchoring is a step. A step is harmless when nothing is being measured
 * and unavoidably lossy when something is: stepping back shortens the open
 * segment, stepping forward over-credits it. So no correction — not even the
 * first — is applied while an entry is open; it waits for the timer to stop,
 * where it costs nothing. An entry therefore never straddles two frames, and
 * its recorded duration is always real elapsed time.
 *
 * The agent closes any open entry at boot, so in the normal case the first
 * sample lands while idle and everything tracked afterwards is already in the
 * server's frame. Only a timer started in the seconds before that first
 * heartbeat stays in the device's frame, and only until it stops. Drift within
 * a single session is bounded by the device's oscillator (parts per million)
 * rather than by the initial skew.
 *
 * Stepping while idle can move the clock backwards. That is deliberate — it is
 * what NTP does, and with nothing accruing the only visible effect is that a
 * fresh entry may overlap one closed before the correction. Totals stay right
 * because the ledger unions overlapping intervals rather than summing them.
 */

/** Ignore corrections below this: normal jitter, not drift worth chasing. */
const MIN_SIGNIFICANT_OFFSET_MS = 1_000;

interface Anchor {
  /** Server wall-clock instant, in ms. */
  serverMs: number;
  /** Monotonic reading taken at the same moment. */
  monoMs: number;
}

/**
 * Monotonic source. Immune to wall-clock edits, DST and NTP steps.
 *
 * Declared once and reused by the test reset so there is a single definition to
 * get wrong — the two copies this replaced meant a test could never notice the
 * shipped default regressing to the wall clock.
 */
const DEFAULT_MONOTONIC = (): number => performance.now();

let monotonicNowMs: () => number = DEFAULT_MONOTONIC;

let anchor: Anchor | null = null;
let deferred: Anchor | null = null;
let trackingActive = false;
let samples = 0;

/**
 * Fold one server timestamp into the anchor.
 *
 * @param serverTimeIso  `serverTime` from the response.
 * @param requestStartedAtMs  local time immediately BEFORE the request went out.
 * @param receivedAtMs  local time immediately AFTER the response arrived.
 * @returns the resulting offset from the device clock, or null if unusable.
 */
export function noteServerTime(
  serverTimeIso: string,
  requestStartedAtMs: number,
  receivedAtMs: number,
): number | null {
  const stampedMs = Date.parse(serverTimeIso);
  if (!Number.isFinite(stampedMs)) return null;
  if (!Number.isFinite(requestStartedAtMs) || !Number.isFinite(receivedAtMs)) return null;

  // `serverTime` is stamped mid-flight, so comparing it to the local time at
  // arrival would bake in a full round trip. Assume symmetric latency and take
  // the midpoint — wrong by at most half the RTT, orders of magnitude below the
  // drift this exists to correct.
  const rttMs = Math.max(0, receivedAtMs - requestStartedAtMs);
  const candidate: Anchor = { serverMs: stampedMs + rttMs / 2, monoMs: monotonicNowMs() };

  samples += 1;

  const driftMs = candidate.serverMs - project(candidate.monoMs);
  if (Math.abs(driftMs) < MIN_SIGNIFICANT_OFFSET_MS) {
    deferred = null;
    return serverClockOffsetMs();
  }

  // Stepping mid-session would add or destroy worked time. Hold it instead;
  // the clock keeps advancing at real rate from the existing anchor.
  if (trackingActive) {
    deferred = candidate;
    return serverClockOffsetMs();
  }

  anchor = candidate;
  deferred = null;
  return serverClockOffsetMs();
}

/**
 * Project the anchored clock forward to a given monotonic reading, seeding the
 * anchor from the device clock on first use.
 *
 * Seeding matters: it puts the clock on the monotonic source from the very
 * first read, so even before a server sample arrives the agent is immune to the
 * device clock being edited underneath a running timer. The seeded anchor is
 * merely in the wrong frame, which the first server sample corrects.
 */
function project(monoMs: number): number {
  if (!anchor) anchor = { serverMs: Date.now(), monoMs };
  return anchor.serverMs + (monoMs - anchor.monoMs);
}

/**
 * Tell the clock whether a timer is currently accruing. A correction that
 * arrived mid-session is applied as soon as tracking stops.
 *
 * Safe to call repeatedly with the same value — the 1s status tick does.
 */
export function setServerClockTrackingActive(active: boolean): void {
  if (trackingActive === active) return;
  trackingActive = active;
  if (active || !deferred) return;
  // A held anchor does not go stale: `now` is derived from the monotonic delta
  // since the anchor was captured, so the wait is accounted for automatically.
  anchor = deferred;
  deferred = null;
}

/** Current device↔server offset in ms. Positive ⇒ this machine is BEHIND. */
export function serverClockOffsetMs(): number {
  if (samples === 0) return 0;
  return serverAlignedNow() - Date.now();
}

/** True once at least one server timestamp has been folded in. */
export function hasServerClockSample(): boolean {
  return samples > 0;
}

/** True while a correction is waiting for the running timer to stop. */
export function hasDeferredServerClockCorrection(): boolean {
  return deferred !== null;
}

/**
 * Server-aligned "now". Between anchors it advances at exactly real rate — it
 * can never freeze, never run backwards, and is unmoved by edits to the device
 * clock. It starts from the device clock and is corrected onto the server's
 * frame by the first sample that lands while no timer is running.
 */
export function serverAlignedNow(): number {
  return project(monotonicNowMs());
}

/** Test seam — module state is process-global. */
export function __resetServerClock(monotonic?: () => number): void {
  anchor = null;
  deferred = null;
  trackingActive = false;
  samples = 0;
  monotonicNowMs = monotonic ?? DEFAULT_MONOTONIC;
}
