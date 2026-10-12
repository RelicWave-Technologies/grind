import { writeFileSync } from 'node:fs';
import { describe, it, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { dateKeyInTimeZone } from '@grind/types';
import { buildApp } from '../../src/app';
import { signAccessToken } from '../../src/lib/jwt';
import * as lark from '../../src/lark';
import type { LarkTaskDto } from '../../src/lark/tasks';
import * as larkCache from '../../src/lark/myTasksCache';
import { ensurePerfSeed, TZ, type PerfFixture } from './seed';
import type { QueryLog } from './setup';

/**
 * Endpoint benchmark against production-shaped volume (see seed.ts).
 *
 *   pnpm --filter @grind/api test:perf                 # local Postgres
 *   PERF_RTT_MS=4 pnpm --filter @grind/api test:perf   # + 4 ms per round trip
 *
 * For each dashboard endpoint: one warm-up call, then PERF_RUNS timed calls;
 * reports the median wall time and the SQL statements one call issues.
 * PERF_OUT=<file> also writes the numbers as JSON (for before/after diffs).
 */

const perfLog = (globalThis as unknown as { __perfLog: QueryLog }).__perfLog;
const RUNS = Number(process.env.PERF_RUNS ?? '3');
const app = buildApp();

interface Result {
  name: string;
  status: number;
  queries: number;
  medianMs: number;
  dbMs: number;
}

const results: Result[] = [];

/** Before the cache existed every call was cold; after, measure both. */
function resetLarkCaches() {
  const mod = larkCache as unknown as { resetLarkTaskCachesForTests?: () => void };
  mod.resetLarkTaskCachesForTests?.();
}

function dateShift(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function measure(name: string, token: string, path: string, before?: () => void) {
  if (process.env.PERF_ONLY && !name.includes(process.env.PERF_ONLY)) return;
  // Warm-up (JIT, Prisma engine, plan cache).
  const warm = await request(app).get(path).set('Authorization', `Bearer ${token}`);
  if (warm.status !== 200) throw new Error(`${name}: ${warm.status} ${JSON.stringify(warm.body).slice(0, 300)}`);
  const times: number[] = [];
  let queries = 0;
  let dbMs = 0;
  for (let i = 0; i < RUNS; i += 1) {
    before?.();
    perfLog.count = 0;
    perfLog.totalDbMs = 0;
    perfLog.queries = [];
    const t0 = performance.now();
    const res = await request(app).get(path).set('Authorization', `Bearer ${token}`);
    times.push(performance.now() - t0);
    if (res.status !== 200) throw new Error(`${name}: ${res.status}`);
    queries = perfLog.count;
    dbMs = perfLog.totalDbMs;
    if (process.env.PERF_TRACE && i === 0) console.log(name, perfLog.queries.join('\n  '));
  }
  times.sort((a, b) => a - b);
  results.push({ name, status: 200, queries, medianMs: Math.round(times[Math.floor(times.length / 2)]!), dbMs: Math.round(dbMs) });
}

/** Lark stand-ins: 40 tasks, 12 of them tracked against in the seed. */
function fakeLark(delayMs: number) {
  const tasks: LarkTaskDto[] = Array.from({ length: 40 }, (_, i) => ({
    guid: `task_${i}`,
    summary: `Task ${i}`,
    completed: false,
    due: null,
    createdAt: null,
    creatorId: `ou_creator_${i % 5}`,
    creatorName: null,
    loggedMs: 0,
    loggedTodayMs: 0,
    loggedTotalMs: 0,
  }));
  lark.setTokenManagerForTests({ getAccessToken: async () => 'u-token' } as unknown as lark.TokenManager);
  lark.setUserTaskClientForTests({
    listMyTasks: async () => {
      await new Promise((r) => setTimeout(r, delayMs));
      return tasks.map((t) => ({ ...t }));
    },
    createTask: async () => { throw new Error('unused'); },
    getOpenId: async () => null,
  });
  lark.setTenantClientForTests({
    namesByOpenId: async (ids: string[]) => {
      await new Promise((r) => setTimeout(r, delayMs / 2));
      return new Map(ids.map((id) => [id, `Name ${id}`]));
    },
  } as unknown as lark.TenantClient);
}

describe('dashboard endpoint benchmark', () => {
  let f: PerfFixture;
  const env = { ...process.env };

  beforeAll(async () => {
    f = await ensurePerfSeed();
    process.env.LARK_APP_ID = 'cli_perf';
    process.env.LARK_APP_SECRET = 'perf';
    process.env.LARK_TOKEN_KEY = 'cGVyZnBlcmZwZXJmcGVyZnBlcmZwZXJmcGVyZnBlcmY=';
    process.env.LARK_CONNECT_REDIRECT_URI = 'http://localhost/v1/lark/oauth/callback';
    fakeLark(Number(process.env.PERF_LARK_MS ?? '300'));
  });

  afterAll(() => {
    process.env = env;
    lark.setTokenManagerForTests(null);
    lark.setUserTaskClientForTests(null);
    lark.setTenantClientForTests(null);
    console.table(results);
    if (process.env.PERF_OUT) writeFileSync(process.env.PERF_OUT, JSON.stringify(results, null, 2));
  });

  it('measures', async () => {
    const admin = signAccessToken({ sub: f.adminId, ws: f.workspaceId, role: 'ADMIN' });
    const manager = signAccessToken({ sub: f.managerId, ws: f.workspaceId, role: 'MANAGER' });
    const member = signAccessToken({ sub: f.memberId, ws: f.workspaceId, role: 'MEMBER' });
    const today = dateKeyInTimeZone(new Date(), TZ);
    const month = today.slice(0, 7);
    const from14 = dateShift(today, -13);
    const from30 = dateShift(today, -29);
    const from7 = dateShift(today, -6);
    const tz = encodeURIComponent(TZ);

    await measure('admin/timesheets 14d', admin, `/v1/admin/timesheets?from=${from14}&to=${today}&tz=${tz}`);
    await measure('admin/timesheets 31d', admin, `/v1/admin/timesheets?from=${dateShift(today, -30)}&to=${today}&tz=${tz}`);
    await measure('reports/month-summary', admin, `/v1/reports/month-summary?month=${month}`);
    await measure('reports/month-summary prev', admin, `/v1/reports/month-summary?month=${dateShift(`${month}-01`, -1).slice(0, 7)}`);
    await measure('admin/manual-time-requests ALL', admin, `/v1/admin/manual-time-requests?status=ALL&from=${from30}&to=${today}&tz=${tz}`);
    await measure('admin/manual-time-requests PENDING', admin, `/v1/admin/manual-time-requests`);
    await measure('reports/team/summary 7d admin', admin, `/v1/reports/team/summary?from=${from7}&to=${today}&tz=${tz}`);
    await measure('reports/team/summary 31d admin', admin, `/v1/reports/team/summary?from=${dateShift(today, -30)}&to=${today}&tz=${tz}`);
    await measure('reports/team/summary 7d manager', manager, `/v1/reports/team/summary?from=${from7}&to=${today}&tz=${tz}`);
    await measure('reports/me 7d', member, `/v1/reports/me?from=${from7}&to=${today}&tz=${tz}`);
    await measure('reports/me 30d', member, `/v1/reports/me?from=${from30}&to=${today}&tz=${tz}`);
    await measure('reports/team/member 7d', admin, `/v1/reports/team/member?userId=${f.memberId}&from=${from7}&to=${today}&tz=${tz}`);
    await measure('reports/team/member 30d', admin, `/v1/reports/team/member?userId=${f.memberId}&from=${from30}&to=${today}&tz=${tz}`);
    await measure('lark/my-tasks cold', member, `/v1/lark/my-tasks?date=${today}&tz=${tz}`, resetLarkCaches);
    await measure('lark/my-tasks warm', member, `/v1/lark/my-tasks?date=${today}&tz=${tz}`);
    await measure('admin/overview', admin, `/v1/admin/overview?tz=${tz}`);
    await measure('leave/calendar', admin, `/v1/leave/calendar?from=${month}-01&to=${dateShift(`${month}-01`, 34)}`);
  });
});
