import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { ulid } from 'ulid';
import { addDays, dateKeyInTimeZone, localDayWindowInTimeZone } from '@grind/types';
import { buildApp } from '../src/app';
import { setTokenManagerForTests } from '../src/lark';
import type { TokenManager } from '../src/lark/tokenManager';
import { decideManualTimeRequest } from '../src/manualTime/decision';
import { loadMonthPerformanceReport, resolveReportMonth } from '../src/reports/monthPerformanceData';
import { loadCreditedManualMs } from '../src/time';
import { seedUser } from './helpers';

/**
 * One fixture day, every screen.
 *
 * Tracked work, an approved manual entry stored on top of it (the overlap the
 * carve now prevents, but old rows still have), trimmed idle under the manual
 * claim, and a reviewer invalidation inside the tracked stretch. Edit Time,
 * the reports popup, the timesheet grid, the overview, Lark task totals, the
 * agent ledger and the month report must all count the same minutes.
 */

const app = buildApp();
const MIN = 60_000;

/** A fixed-offset zone where it is currently around midday, so "today" has a morning behind it. */
function middayZone(now = new Date()): string {
  const offset = 12 - now.getUTCHours();
  if (offset === 0) return 'UTC';
  return offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

async function entry(input: {
  userId: string;
  source: 'AUTO' | 'MANUAL';
  task: string | null;
  segments: Array<{ kind: 'WORK' | 'MEETING' | 'IDLE_TRIMMED'; start: number; end: number | null }>;
  endedAt?: number | null;
}) {
  const id = ulid();
  const first = input.segments[0]!;
  const last = input.segments[input.segments.length - 1]!;
  await prisma.timeEntry.create({
    data: {
      id,
      clientUuid: ulid(),
      userId: input.userId,
      source: input.source,
      larkTaskGuid: input.task,
      startedAt: new Date(first.start),
      endedAt: input.endedAt === undefined ? (last.end === null ? null : new Date(last.end)) : input.endedAt === null ? null : new Date(input.endedAt),
      segments: {
        create: input.segments.map((s) => ({
          id: ulid(),
          kind: s.kind,
          startedAt: new Date(s.start),
          endedAt: s.end === null ? null : new Date(s.end),
        })),
      },
    },
  });
  return id;
}

async function invalidate(workspaceId: string, userId: string, start: number, end: number) {
  const flag = await prisma.activityFlag.create({
    data: {
      userId,
      type: 'JIGGLER',
      windowStart: new Date(start),
      windowEnd: new Date(end),
      riskScore: 50,
      evidence: {},
      status: 'RESOLVED',
      resolution: 'TIME_INVALIDATED',
    },
  });
  await prisma.timeInvalidation.create({
    data: {
      workspaceId,
      flagId: flag.id,
      userId,
      windowStart: new Date(start),
      windowEnd: new Date(end),
      reason: 'jiggler',
    },
  });
}

afterEach(() => {
  setTokenManagerForTests(null);
  vi.unstubAllGlobals();
  for (const key of ['LARK_APP_ID', 'LARK_APP_SECRET', 'LARK_TOKEN_KEY', 'LARK_CONNECT_REDIRECT_URI', 'LARK_OAUTH_HOST']) {
    delete process.env[key];
  }
});

describe('one day, every screen', () => {
  it('Edit Time == reports == grid == overview == Lark tasks == agent ledger == month report', async () => {
    const now = new Date();
    const tz = middayZone(now);
    const u = await seedUser({ role: 'ADMIN' });
    await prisma.workspace.update({ where: { id: u.workspaceId }, data: { timezone: tz } });
    const date = dateKeyInTimeZone(now, tz);
    const day = localDayWindowInTimeZone(date, tz)!;
    const at = (h: number, m = 0) => day.start.getTime() + (h * 60 + m) * MIN;
    expect(at(11)).toBeLessThan(now.getTime());

    // 08:00–10:00 tracked on task A, then trimmed idle to 10:30.
    await entry({
      userId: u.userId,
      source: 'AUTO',
      task: 'task-a',
      segments: [
        { kind: 'WORK', start: at(8), end: at(10) },
        { kind: 'IDLE_TRIMMED', start: at(10), end: at(10, 30) },
      ],
    });
    // An approved manual entry stored on top: 09:00–10:45 on task M.
    await entry({ userId: u.userId, source: 'MANUAL', task: 'task-m', segments: [{ kind: 'WORK', start: at(9), end: at(10, 45) }] });
    // A reviewer invalidated 08:30–08:45.
    await invalidate(u.workspaceId, u.userId, at(8, 30), at(8, 45));

    // Expected: tracked 120 − 15 invalidated = 105; manual keeps 10:00–10:45 = 45.
    const counted = 150 * MIN;
    const auth = { Authorization: `Bearer ${u.accessToken}` };

    const editTime = await request(app).get(`/v1/insights/day?date=${date}&gapScope=calendar-day`).set(auth);
    expect(editTime.status).toBe(200);
    const t = editTime.body.totals;
    expect(t.workedMs + t.meetingMs + t.manualMs).toBe(counted);
    expect(t.manualMs).toBe(45 * MIN);
    expect(t.invalidatedMs).toBe(15 * MIN);
    expect(editTime.body.firstActivityAt).toBe(at(8));

    const reports = await request(app).get(`/v1/reports/me?from=${date}&to=${date}`).set(auth);
    expect(reports.status).toBe(200);
    const r = reports.body.days[0];
    expect(r.workedMs + r.meetingMs + r.manualMs).toBe(counted);
    expect(r.invalidatedMs).toBe(15 * MIN);

    const grid = await request(app).get(`/v1/admin/timesheets?from=${date}&to=${date}`).set(auth);
    expect(grid.status).toBe(200);
    expect(grid.body.cells[u.userId][date].totalMs).toBe(counted);

    const overview = await request(app).get('/v1/admin/overview').set(auth);
    expect(overview.status).toBe(200);
    const o = overview.body.today;
    expect(o.workedHours + o.meetingHours + o.manualHours).toBeCloseTo(counted / 3_600_000, 2);

    // Lark: the route's task totals, through a faked task list.
    process.env.LARK_APP_ID = 'cli_test';
    process.env.LARK_APP_SECRET = 'secret';
    process.env.LARK_TOKEN_KEY = 'k'.repeat(32);
    process.env.LARK_CONNECT_REDIRECT_URI = 'http://localhost/v1/lark/oauth/callback';
    process.env.LARK_OAUTH_HOST = 'https://lark.test';
    setTokenManagerForTests({ getAccessToken: async () => 'user-token' } as unknown as TokenManager);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      data: { items: [{ guid: 'task-a', summary: 'A' }, { guid: 'task-m', summary: 'M' }], has_more: false },
    }))));
    const lark = await request(app).get(`/v1/lark/my-tasks?date=${date}`).set(auth);
    expect(lark.status).toBe(200);
    const byGuid = new Map((lark.body.tasks as Array<{ guid: string; loggedTodayMs: number }>).map((x) => [x.guid, x.loggedTodayMs]));
    expect(byGuid.get('task-a')).toBe(105 * MIN);
    expect(byGuid.get('task-m')).toBe(45 * MIN);
    expect([...byGuid.values()].reduce((a, b) => a + b, 0)).toBe(counted);

    // The agent ledger is handed the same invalidation to subtract.
    const ledger = await request(app)
      .get('/v1/agent/today-ledger')
      .query({ from: day.start.toISOString(), to: day.end.toISOString() })
      .set(auth);
    expect(ledger.status).toBe(200);
    expect(ledger.body.invalidations).toEqual([
      { startedAt: new Date(at(8, 30)).toISOString(), endedAt: new Date(at(8, 45)).toISOString() },
    ]);

    const month = resolveReportMonth({ month: date.slice(0, 7) }, tz);
    if ('error' in month) throw new Error(month.error);
    const report = await loadMonthPerformanceReport({ workspaceId: u.workspaceId, userIds: [u.userId], range: month });
    expect(report.rows[0]!.days.find((d) => d.date === date)!.workMinutes).toBe(150);
  });
});

describe('manual time carving', () => {
  async function pending(userId: string, start: number, end: number) {
    return prisma.manualTimeRequest.create({
      data: { clientUuid: ulid(), userId, requestedStart: new Date(start), requestedEnd: new Date(end), reason: 'forgot', status: 'PENDING' },
    });
  }

  function approve(u: { userId: string }, requestId: string) {
    return decideManualTimeRequest({
      requestId,
      action: 'approve',
      source: 'DASHBOARD',
      deciderUserId: u.userId,
      deciderRole: 'ADMIN',
      scopeUserIds: [u.userId],
    });
  }

  async function creditedMs(requestId: string): Promise<number> {
    const r = await prisma.manualTimeRequest.findUniqueOrThrow({ where: { id: requestId } });
    return (await loadCreditedManualMs([r])).get(requestId) ?? 0;
  }

  it('an open legacy entry capped at its last proof does not swallow an approved request', async () => {
    const u = await seedUser({ role: 'ADMIN' });
    const yesterday = addDays(dateKeyInTimeZone(new Date(), 'UTC'), -1);
    const at = (h: number, m = 0) => Date.parse(`${yesterday}T00:00:00Z`) + (h * 60 + m) * MIN;
    // A legacy timer left open since 08:00; the last thing it proved was 08:40.
    const legacy = await entry({ userId: u.userId, source: 'AUTO', task: null, segments: [{ kind: 'WORK', start: at(8), end: null }], endedAt: null });
    await prisma.activitySample.create({
      data: { id: ulid(), userId: u.userId, timeEntryId: legacy, bucketStart: new Date(at(8, 39)), keystrokes: 10, clicks: 1, mouseDistancePx: 5, scrollEvents: 0 },
    });

    const req = await pending(u.userId, at(9), at(10));
    const out = await approve(u, req.id);
    expect(out?.status).toBe('APPROVED');
    expect(out?.timeEntryId).not.toBeNull();
    expect(await creditedMs(req.id)).toBe(60 * MIN);
  });

  it('two overlapping approvals racing never carve the same minutes', async () => {
    const u = await seedUser({ role: 'ADMIN' });
    const yesterday = addDays(dateKeyInTimeZone(new Date(), 'UTC'), -1);
    const at = (h: number, m = 0) => Date.parse(`${yesterday}T00:00:00Z`) + (h * 60 + m) * MIN;
    const a = await pending(u.userId, at(9), at(10));
    const b = await pending(u.userId, at(9, 30), at(10, 30));
    await Promise.all([approve(u, a.id), approve(u, b.id)]);
    // 90 minutes of clock, credited once.
    expect((await creditedMs(a.id)) + (await creditedMs(b.id))).toBe(90 * MIN);
  });

  it('deleting a manual entry gives its minutes back to the request carved around it', async () => {
    const u = await seedUser({ role: 'ADMIN' });
    const yesterday = addDays(dateKeyInTimeZone(new Date(), 'UTC'), -1);
    const at = (h: number, m = 0) => Date.parse(`${yesterday}T00:00:00Z`) + (h * 60 + m) * MIN;
    const a = await pending(u.userId, at(9), at(10));
    const b = await pending(u.userId, at(9, 30), at(10, 30));
    const first = await approve(u, a.id);
    await approve(u, b.id);
    expect(await creditedMs(b.id)).toBe(30 * MIN);

    const res = await request(app)
      .delete(`/v1/time-entries/${first!.timeEntryId}`)
      .set({ Authorization: `Bearer ${u.accessToken}` });
    expect(res.status).toBe(200);
    expect(await creditedMs(b.id)).toBe(60 * MIN);
  });

  it('a PATCH that loses the race to an approval is refused, not applied', async () => {
    const u = await seedUser({ role: 'ADMIN' });
    const yesterday = addDays(dateKeyInTimeZone(new Date(), 'UTC'), -1);
    const at = (h: number, m = 0) => Date.parse(`${yesterday}T00:00:00Z`) + (h * 60 + m) * MIN;
    const req = await pending(u.userId, at(9), at(10));

    let patch: Promise<request.Response> | null = null;
    await prisma.$transaction(async (tx) => {
      // The approval holds the row; the PATCH has already read it as PENDING.
      await tx.$queryRaw`SELECT id FROM "ManualTimeRequest" WHERE id = ${req.id} FOR UPDATE`;
      await tx.manualTimeRequest.update({ where: { id: req.id }, data: { status: 'APPROVED', decidedAt: new Date() } });
      patch = request(app)
        .patch(`/v1/time-requests/${req.id}`)
        .set({ Authorization: `Bearer ${u.accessToken}` })
        .send({ requestedEnd: new Date(at(12)).toISOString() })
        .then((r) => r);
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    const res = await patch!;
    expect(res.status).toBe(409);
    const after = await prisma.manualTimeRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(after.status).toBe('APPROVED');
    expect(after.requestedEnd.getTime()).toBe(at(10));
  });
});
