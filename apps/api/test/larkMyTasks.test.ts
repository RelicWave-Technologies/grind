import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { ulid } from 'ulid';
import { buildApp } from '../src/app';
import * as lark from '../src/lark';
import { resetLarkTaskCachesForTests } from '../src/lark/myTasksCache';
import type { LarkTaskDto, UserTaskClient } from '../src/lark/tasks';
import { seedUser } from './helpers';

/**
 * GET /v1/lark/my-tasks behind its per-person cache: Lark is asked once per
 * TTL (and once for concurrent callers), the logged time stays live, and a
 * created task or a (dis)connect is visible on the next call.
 */

const app = buildApp();
const LARK_ENV = {
  LARK_APP_ID: 'cli_test',
  LARK_APP_SECRET: 'secret',
  LARK_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'),
  LARK_CONNECT_REDIRECT_URI: 'http://localhost:4000/v1/lark/oauth/callback',
};
const saved: Record<string, string | undefined> = {};

function larkTask(guid: string, creatorId: string | null = 'ou_creator'): LarkTaskDto {
  return {
    guid,
    summary: `Task ${guid}`,
    completed: false,
    due: null,
    createdAt: null,
    creatorId,
    creatorName: null,
    loggedMs: 0,
    loggedTodayMs: 0,
    loggedTotalMs: 0,
  };
}

let listed: LarkTaskDto[] = [];
let listDelayMs = 0;
let reauth = false;
const listMyTasks = vi.fn<UserTaskClient['listMyTasks']>();
const namesByOpenId = vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, `Name of ${id}`])));

beforeAll(() => {
  for (const [k, v] of Object.entries(LARK_ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  lark.setTokenManagerForTests(null);
  lark.setUserTaskClientForTests(null);
  lark.setTenantClientForTests(null);
  resetLarkTaskCachesForTests();
});

beforeEach(() => {
  resetLarkTaskCachesForTests();
  listed = [larkTask('g1'), larkTask('g2', null)];
  listDelayMs = 0;
  reauth = false;
  listMyTasks.mockReset();
  listMyTasks.mockImplementation(async () => {
    if (listDelayMs) await new Promise((r) => setTimeout(r, listDelayMs));
    return listed.map((t) => ({ ...t }));
  });
  namesByOpenId.mockClear();
  lark.setTokenManagerForTests({
    getAccessToken: async () => {
      if (reauth) throw new lark.LarkReauthRequiredError();
      return 'u-token';
    },
    disconnect: async () => {},
  } as unknown as lark.TokenManager);
  lark.setUserTaskClientForTests({
    listMyTasks,
    createTask: async (_token, input) => larkTask(`created-${input.summary}`),
    getOpenId: async () => 'ou_me',
  });
  lark.setTenantClientForTests({ namesByOpenId } as unknown as lark.TenantClient);
});

async function track(userId: string, guid: string, startMs: number, minutes: number) {
  const startedAt = new Date(startMs);
  const endedAt = new Date(startMs + minutes * 60_000);
  await prisma.timeEntry.create({
    data: {
      id: ulid(),
      clientUuid: ulid(),
      userId,
      larkTaskGuid: guid,
      source: 'AUTO',
      startedAt,
      endedAt,
      segments: { create: [{ id: ulid(), kind: 'WORK', startedAt, endedAt }] },
    },
  });
}

const get = (token: string) => request(app).get('/v1/lark/my-tasks').set('Authorization', `Bearer ${token}`);

describe('GET /v1/lark/my-tasks (cached)', () => {
  it('asks Lark once per TTL while the logged time stays live', async () => {
    const { userId, accessToken } = await seedUser();
    const base = Date.now() - 6 * 3_600_000;
    await track(userId, 'g1', base, 30);

    const first = await get(accessToken);
    expect(first.status).toBe(200);
    expect(first.body.tasks).toHaveLength(2);
    const g1 = first.body.tasks.find((t: LarkTaskDto) => t.guid === 'g1');
    expect(g1).toMatchObject({ loggedTotalMs: 30 * 60_000, loggedMs: 30 * 60_000, creatorName: 'Name of ou_creator' });
    expect(first.body.tasks.find((t: LarkTaskDto) => t.guid === 'g2')).toMatchObject({ creatorName: null, loggedMs: 0 });

    // More time lands; Lark is not asked again, the total still moves.
    await track(userId, 'g1', base + 60 * 60_000, 15);
    const second = await get(accessToken);
    expect(second.status).toBe(200);
    expect(second.body.tasks.find((t: LarkTaskDto) => t.guid === 'g1').loggedTotalMs).toBe(45 * 60_000);
    expect(listMyTasks).toHaveBeenCalledTimes(1);
    expect(namesByOpenId).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent calls into one Lark request', async () => {
    const { accessToken } = await seedUser();
    listDelayMs = 50;
    const results = await Promise.all([get(accessToken), get(accessToken), get(accessToken)]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(listMyTasks).toHaveBeenCalledTimes(1);
  });

  it('caches per person', async () => {
    const a = await seedUser();
    const b = await seedUser();
    await get(a.accessToken);
    await get(b.accessToken);
    expect(listMyTasks).toHaveBeenCalledTimes(2);
  });

  it('shows a task created through Timo on the next call', async () => {
    const { accessToken } = await seedUser();
    await get(accessToken);
    const created = await request(app)
      .post('/v1/lark/tasks')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ summary: 'new one' });
    expect(created.status).toBe(201);
    listed = [...listed, larkTask('created-new one')];
    const after = await get(accessToken);
    expect(after.body.tasks.map((t: LarkTaskDto) => t.guid)).toContain('created-new one');
    expect(listMyTasks).toHaveBeenCalledTimes(2);
  });

  it('forgets the list on disconnect', async () => {
    const { accessToken } = await seedUser();
    await get(accessToken);
    await request(app).post('/v1/lark/disconnect').set('Authorization', `Bearer ${accessToken}`).expect(200);
    await get(accessToken);
    expect(listMyTasks).toHaveBeenCalledTimes(2);
  });

  it('still answers 409 when the grant needs reauthorising, cached list or not', async () => {
    const { accessToken } = await seedUser();
    await get(accessToken);
    reauth = true;
    const res = await get(accessToken);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'reauth_required' });
  });

  it('passes a Lark error through when there is nothing cached', async () => {
    const { accessToken } = await seedUser();
    listMyTasks.mockRejectedValueOnce(new lark.LarkTaskApiError('list', 99991400, 'rate limited'));
    const res = await get(accessToken);
    expect(res.status).toBe(500);
  });
});
