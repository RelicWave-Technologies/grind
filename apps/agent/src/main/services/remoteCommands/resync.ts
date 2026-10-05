import {
  ResyncCommandParams,
  localDayWindowInTimeZone,
  type ResyncCommandResult,
} from '@grind/types';

/**
 * RESYNC: re-send this laptop's local record of a date range.
 *
 * The laptop's diary is the source of truth and the server merges what it is
 * sent, so a resend can only add what the server is missing:
 *   - timer entries go out again with a bumped revision (see
 *     TimerService.resyncRange);
 *   - activity minutes go back on the upload queue (the server keeps the larger
 *     count);
 *   - screenshots not yet uploaded, or written off, are queued again; uploaded
 *     ones are only counted.
 * Then the normal drains are kicked and the run waits (bounded) for the timer
 * and activity backlog of that range to clear before reporting counts.
 */

interface ResyncOwner {
  userId: string;
  workspaceId: string;
}

export interface ResyncDeps {
  owner(): ResyncOwner | null;
  /** The workspace timezone this agent is running on, when known. */
  timeZone(): string | null;
  timer: {
    resyncRange(startMs: number, endMs: number): { requeued: number; openRequeued: boolean; skippedRecovered: number };
    rangeBacklog(startMs: number, endMs: number): { pending: number; lastErrors: string[] };
  };
  activity: {
    markUnsyncedInRange(owner: ResyncOwner, startMs: number, endMs: number): number;
    unsyncedInRange(owner: ResyncOwner, startMs: number, endMs: number): number;
  };
  screenshots: {
    requeueRange(owner: ResyncOwner, startMs: number, endMs: number): { requeued: number; uploaded: number };
    rangeSummary(owner: ResyncOwner, startMs: number, endMs: number): { pending: number; uploaded: number; failed: number };
  };
  /** Kick the timer, activity and screenshot drains. Fire and forget. */
  kickDrains(): void;
  device(): { appVersion: string; os: string; arch: string };
  now(): number;
  sleep(ms: number): Promise<void>;
  /** How long to wait for the backlog to clear. Default 120s. */
  waitMs?: number;
  /** How often to look. Default 5s. */
  pollMs?: number;
}

const RESYNC_WAIT_MS = 120_000;
const RESYNC_POLL_MS = 5_000;

export async function runResync(rawParams: unknown, deps: ResyncDeps): Promise<ResyncCommandResult> {
  const startedAt = deps.now();
  const parsed = ResyncCommandParams.safeParse(rawParams);
  if (!parsed.success) throw new Error('invalid_params');
  const { from, to } = parsed.data;
  if (from > to) throw new Error('invalid_range');
  const owner = deps.owner();
  if (!owner) throw new Error('signed_out');

  const timeZone = deps.timeZone() ?? parsed.data.timeZone ?? 'UTC';
  const first = localDayWindowInTimeZone(from, timeZone);
  const last = localDayWindowInTimeZone(to, timeZone);
  if (!first || !last) throw new Error('invalid_range');
  const startMs = first.start.getTime();
  const endMs = last.end.getTime();

  const timer = deps.timer.resyncRange(startMs, endMs);
  const activityRequeued = deps.activity.markUnsyncedInRange(owner, startMs, endMs);
  const shots = deps.screenshots.requeueRange(owner, startMs, endMs);
  deps.kickDrains();

  const waitMs = deps.waitMs ?? RESYNC_WAIT_MS;
  const pollMs = deps.pollMs ?? RESYNC_POLL_MS;
  const deadline = deps.now() + waitMs;
  let timedOut = false;
  for (;;) {
    const timerPending = deps.timer.rangeBacklog(startMs, endMs).pending;
    const activityPending = deps.activity.unsyncedInRange(owner, startMs, endMs);
    if (timerPending === 0 && activityPending === 0) break;
    if (deps.now() >= deadline) {
      timedOut = true;
      break;
    }
    await deps.sleep(pollMs);
    deps.kickDrains();
  }

  const timerAfter = deps.timer.rangeBacklog(startMs, endMs);
  const shotsAfter = deps.screenshots.rangeSummary(owner, startMs, endMs);
  return {
    range: {
      from,
      to,
      timeZone,
      startAt: new Date(startMs).toISOString(),
      endAt: new Date(endMs).toISOString(),
    },
    timer: {
      requeued: timer.requeued,
      openRequeued: timer.openRequeued,
      skippedRecovered: timer.skippedRecovered,
      pendingAfter: timerAfter.pending,
      lastErrors: timerAfter.lastErrors,
    },
    activity: {
      requeued: activityRequeued,
      pendingAfter: deps.activity.unsyncedInRange(owner, startMs, endMs),
    },
    screenshots: {
      requeued: shots.requeued,
      uploaded: shotsAfter.uploaded,
      failed: shotsAfter.failed,
      pendingAfter: shotsAfter.pending,
    },
    ...deps.device(),
    durationMs: deps.now() - startedAt,
    timedOut,
  };
}
