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
 * stamping in the server's frame of reference. Every heartbeat response already
 * carries `serverTime`, so we track the offset and apply it.
 *
 * Two guarantees this must keep:
 *
 *  1. **Monotonic.** A running timer computes durations from `now()`. If the
 *     first correction shifted the clock backwards, `now` could land before an
 *     entry's `startedAt` and produce negative worked time — worse than the bug
 *     being fixed. `now()` therefore never returns less than it last returned.
 *
 *  2. **Latency-aware.** `serverTime` is stamped mid-flight, so comparing it to
 *     the local time at response arrival would bake in a full round trip. We
 *     compare against the midpoint of the request window instead, which assumes
 *     symmetric latency — wrong by at most half the RTT, orders of magnitude
 *     below the drift this exists to correct.
 */

/** Ignore corrections below this: normal jitter, not drift worth chasing. */
const MIN_SIGNIFICANT_OFFSET_MS = 1_000;

let offsetMs = 0;
let lastReturnedMs = 0;
let samples = 0;

/**
 * Fold one server timestamp into the offset.
 *
 * @param serverTimeIso  `serverTime` from the response.
 * @param requestStartedAtMs  local time immediately BEFORE the request went out.
 * @param receivedAtMs  local time immediately AFTER the response arrived.
 */
export function noteServerTime(
  serverTimeIso: string,
  requestStartedAtMs: number,
  receivedAtMs: number,
): number | null {
  const serverMs = Date.parse(serverTimeIso);
  if (!Number.isFinite(serverMs)) return null;
  if (!Number.isFinite(requestStartedAtMs) || !Number.isFinite(receivedAtMs)) return null;
  const rttMs = Math.max(0, receivedAtMs - requestStartedAtMs);
  const localAtServerStamp = requestStartedAtMs + rttMs / 2;
  const nextOffset = serverMs - localAtServerStamp;
  samples += 1;
  if (Math.abs(nextOffset - offsetMs) < MIN_SIGNIFICANT_OFFSET_MS) return offsetMs;
  offsetMs = nextOffset;
  return offsetMs;
}

/** Current local↔server offset in ms. Positive ⇒ this machine is BEHIND. */
export function serverClockOffsetMs(): number {
  return offsetMs;
}

/** True once at least one server timestamp has been folded in. */
export function hasServerClockSample(): boolean {
  return samples > 0;
}

/**
 * Server-aligned "now", never moving backwards. Use for anything the server
 * will validate; plain `Date.now()` is still right for local-only durations.
 */
export function serverAlignedNow(localNowMs: number = Date.now()): number {
  const aligned = localNowMs + offsetMs;
  lastReturnedMs = aligned > lastReturnedMs ? aligned : lastReturnedMs;
  return lastReturnedMs;
}

/** Test seam — module state is process-global. */
export function __resetServerClock(): void {
  offsetMs = 0;
  lastReturnedMs = 0;
  samples = 0;
}
