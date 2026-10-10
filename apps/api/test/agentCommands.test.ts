import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { runPruneOnce } from '../src/maintenance/prune';
import { seedUser, type SeededUser } from './helpers';

const app = buildApp();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const DAY = 24 * 60 * 60_000;
const MIN = 60_000;

const previousDevelopers = process.env.DEVELOPER_EMAILS;
afterEach(() => {
  if (previousDevelopers === undefined) delete process.env.DEVELOPER_EMAILS;
  else process.env.DEVELOPER_EMAILS = previousDevelopers;
});

async function emailOf(user: SeededUser): Promise<string> {
  return (await prisma.user.findUniqueOrThrow({ where: { id: user.userId }, select: { email: true } })).email;
}

/** A developer and a target member in the developer's workspace. */
async function seedDeveloperAndTarget() {
  const developer = await seedUser({ role: 'MEMBER' });
  const target = await prisma.user.create({
    data: {
      workspaceId: developer.workspaceId,
      email: `target-${Date.now()}@test.local`,
      name: 'Target Person',
      provisioningStatus: 'ACTIVE',
    },
  });
  const { signAccessToken } = await import('../src/lib/jwt');
  const targetToken = signAccessToken({ sub: target.id, ws: developer.workspaceId, role: 'MEMBER' });
  process.env.DEVELOPER_EMAILS = (await emailOf(developer)).toUpperCase();
  return { developer, target, targetToken };
}

function heartbeat(token: string) {
  return request(app)
    .post('/v1/agent/heartbeat')
    .set(bearer(token))
    .send({ agentVersion: '0.1.0', platform: 'darwin', state: 'IDLE' });
}

describe('developer gate', () => {
  it('404s for everyone when DEVELOPER_EMAILS is empty', async () => {
    const admin = await seedUser({ role: 'ADMIN' });
    process.env.DEVELOPER_EMAILS = '';
    const res = await request(app).get('/v1/dev/agent-commands').set(bearer(admin.accessToken));
    expect(res.status).toBe(404);
    const me = await request(app).get('/v1/auth/me').set(bearer(admin.accessToken));
    expect(me.body.user.isDeveloper).toBe(false);
  });

  it('404s for a non-developer, admins included, and admits the developer', async () => {
    const { developer } = await seedDeveloperAndTarget();
    const admin = await prisma.user.create({
      data: { workspaceId: developer.workspaceId, email: `admin-${Date.now()}@test.local`, name: 'Admin', role: 'ADMIN', provisioningStatus: 'ACTIVE' },
    });
    const { signAccessToken } = await import('../src/lib/jwt');
    const adminToken = signAccessToken({ sub: admin.id, ws: developer.workspaceId, role: 'ADMIN' });

    expect((await request(app).get('/v1/dev/agent-commands').set(bearer(adminToken))).status).toBe(404);
    expect((await request(app).post('/v1/dev/agent-commands').set(bearer(adminToken)).send({})).status).toBe(404);
    expect((await request(app).get('/v1/dev/people').set(bearer(adminToken))).status).toBe(404);
    const adminMe = await request(app).get('/v1/auth/me').set(bearer(adminToken));
    expect(adminMe.body.user.isDeveloper).toBe(false);

    const ok = await request(app).get('/v1/dev/agent-commands').set(bearer(developer.accessToken));
    expect(ok.status).toBe(200);
    expect(ok.body.commands).toEqual([]);
    const me = await request(app).get('/v1/auth/me').set(bearer(developer.accessToken));
    expect(me.body.user.isDeveloper).toBe(true);
    const people = await request(app).get('/v1/dev/people').set(bearer(developer.accessToken));
    expect(people.status).toBe(200);
    expect(people.body.people.map((p: { name: string }) => p.name)).toContain('Target Person');
  });
});

describe('POST /v1/dev/agent-commands', () => {
  it('creates a RESYNC for a person by id or email, with the workspace timezone', async () => {
    const { developer, target } = await seedDeveloperAndTarget();
    await prisma.workspace.update({ where: { id: developer.workspaceId }, data: { timezone: 'Asia/Kolkata' } });
    const byId = await request(app)
      .post('/v1/dev/agent-commands')
      .set(bearer(developer.accessToken))
      .send({ userId: target.id, type: 'RESYNC', from: '2026-10-01', to: '2026-10-05' });
    expect(byId.status).toBe(201);
    expect(byId.body).toMatchObject({
      type: 'RESYNC',
      status: 'PENDING',
      params: { from: '2026-10-01', to: '2026-10-05', timeZone: 'Asia/Kolkata' },
      user: { id: target.id, name: 'Target Person' },
      requestedBy: { id: developer.userId },
      deliveredAt: null,
      completedAt: null,
    });

    const byEmail = await request(app)
      .post('/v1/dev/agent-commands')
      .set(bearer(developer.accessToken))
      .send({ email: target.email.toUpperCase(), type: 'RESYNC', from: '2026-10-05', to: '2026-10-05' });
    expect(byEmail.status).toBe(201);
    expect(byEmail.body.user.id).toBe(target.id);

    const list = await request(app).get(`/v1/dev/agent-commands?userId=${target.id}`).set(bearer(developer.accessToken));
    expect(list.body.commands.map((c: { id: string }) => c.id)).toEqual([byEmail.body.id, byId.body.id]);
    const one = await request(app).get(`/v1/dev/agent-commands/${byId.body.id}`).set(bearer(developer.accessToken));
    expect(one.status).toBe(200);
    expect(one.body.user.email).toBe(target.email);
  });

  it('validates the range and the target', async () => {
    const { developer, target } = await seedDeveloperAndTarget();
    const post = (body: Record<string, unknown>) =>
      request(app).post('/v1/dev/agent-commands').set(bearer(developer.accessToken)).send({ type: 'RESYNC', ...body });

    expect((await post({ userId: target.id, from: '2026-10-05', to: '2026-10-01' })).body.error).toBe('invalid_range');
    const tooLong = await post({ userId: target.id, from: '2026-09-01', to: '2026-10-02' });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error).toBe('range_too_long');
    expect((await post({ userId: target.id, from: '2026-09-01', to: '2026-09-31' })).status).toBe(400);
    expect((await post({ from: '2026-10-01', to: '2026-10-01' })).status).toBe(400);
    // 31 days inclusive (1 Sep - 1 Oct) is the limit.
    expect((await post({ userId: target.id, from: '2026-09-01', to: '2026-10-01' })).status).toBe(201);

    const stranger = await seedUser();
    const other = await post({ userId: stranger.userId, from: '2026-10-01', to: '2026-10-01' });
    expect(other.status).toBe(404);
    expect(other.body.error).toBe('user_not_found');
  });
});

describe('heartbeat delivery and agent results', () => {
  let ctx: Awaited<ReturnType<typeof seedDeveloperAndTarget>>;
  let commandId: string;

  beforeEach(async () => {
    ctx = await seedDeveloperAndTarget();
    const created = await request(app)
      .post('/v1/dev/agent-commands')
      .set(bearer(ctx.developer.accessToken))
      .send({ userId: ctx.target.id, type: 'RESYNC', from: '2026-10-04', to: '2026-10-05' });
    commandId = created.body.id;
  });

  it('delivers a pending command once and marks it DELIVERED', async () => {
    const devBeat = await heartbeat(ctx.developer.accessToken);
    expect(devBeat.status).toBe(200);
    expect(devBeat.body.commands).toBeUndefined();

    const first = await heartbeat(ctx.targetToken);
    expect(first.status).toBe(200);
    expect(first.body.commands).toEqual([
      { id: commandId, type: 'RESYNC', params: { from: '2026-10-04', to: '2026-10-05', timeZone: 'UTC' } },
    ]);
    const row = await prisma.agentCommand.findUniqueOrThrow({ where: { id: commandId } });
    expect(row.status).toBe('DELIVERED');
    expect(row.deliveredAt).toBeInstanceOf(Date);

    const second = await heartbeat(ctx.targetToken);
    expect(second.body.commands).toBeUndefined();
  });

  it('hands a DELIVERED command out again after 10 minutes without a result', async () => {
    await heartbeat(ctx.targetToken);
    await prisma.agentCommand.update({ where: { id: commandId }, data: { deliveredAt: new Date(Date.now() - 11 * MIN) } });
    const again = await heartbeat(ctx.targetToken);
    expect(again.body.commands?.map((c: { id: string }) => c.id)).toEqual([commandId]);
    const row = await prisma.agentCommand.findUniqueOrThrow({ where: { id: commandId } });
    expect(Date.now() - row.deliveredAt!.getTime()).toBeLessThan(MIN);
    // Fresh deliveredAt: not handed out on the very next tick.
    expect((await heartbeat(ctx.targetToken)).body.commands).toBeUndefined();

    // A completed command is never redelivered.
    await request(app)
      .post(`/v1/agent/commands/${commandId}/result`)
      .set(bearer(ctx.targetToken))
      .send({ status: 'DONE', result: { ok: 1 } });
    await prisma.agentCommand.update({ where: { id: commandId }, data: { deliveredAt: new Date(Date.now() - 11 * MIN) } });
    expect((await heartbeat(ctx.targetToken)).body.commands).toBeUndefined();
  });

  it('records the result only from the target, idempotently', async () => {
    await heartbeat(ctx.targetToken);
    const fromDeveloper = await request(app)
      .post(`/v1/agent/commands/${commandId}/result`)
      .set(bearer(ctx.developer.accessToken))
      .send({ status: 'DONE' });
    expect(fromDeveloper.status).toBe(404);
    const missing = await request(app)
      .post('/v1/agent/commands/nope/result')
      .set(bearer(ctx.targetToken))
      .send({ status: 'DONE' });
    expect(missing.status).toBe(404);
    const bad = await request(app)
      .post(`/v1/agent/commands/${commandId}/result`)
      .set(bearer(ctx.targetToken))
      .send({ status: 'MAYBE' });
    expect(bad.status).toBe(400);

    const result = { timer: { requeued: 3, pendingAfter: 0, lastErrors: [] }, durationMs: 1200 };
    const first = await request(app)
      .post(`/v1/agent/commands/${commandId}/result`)
      .set(bearer(ctx.targetToken))
      .send({ status: 'DONE', result });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true, status: 'DONE', alreadyCompleted: false });
    const row = await prisma.agentCommand.findUniqueOrThrow({ where: { id: commandId } });
    expect(row.status).toBe('DONE');
    expect(row.result).toEqual(result);
    expect(row.completedAt).toBeInstanceOf(Date);

    const repeat = await request(app)
      .post(`/v1/agent/commands/${commandId}/result`)
      .set(bearer(ctx.targetToken))
      .send({ status: 'FAILED', error: 'late duplicate' });
    expect(repeat.status).toBe(200);
    expect(repeat.body).toEqual({ ok: true, status: 'DONE', alreadyCompleted: true });
    const after = await prisma.agentCommand.findUniqueOrThrow({ where: { id: commandId } });
    expect(after.status).toBe('DONE');
    expect(after.error).toBeNull();
    expect(after.completedAt).toEqual(row.completedAt);

    const shown = await request(app).get(`/v1/dev/agent-commands/${commandId}`).set(bearer(ctx.developer.accessToken));
    expect(shown.body).toMatchObject({ status: 'DONE', result });
  });

  it('records a FAILED result with its error', async () => {
    const res = await request(app)
      .post(`/v1/agent/commands/${commandId}/result`)
      .set(bearer(ctx.targetToken))
      .send({ status: 'FAILED', error: 'signed_out' });
    expect(res.status).toBe(200);
    const row = await prisma.agentCommand.findUniqueOrThrow({ where: { id: commandId } });
    expect(row).toMatchObject({ status: 'FAILED', error: 'signed_out', result: null });
  });
});

describe('prune: agent commands', () => {
  it('expires week-old open commands and deletes month-old completed ones', async () => {
    const { developer, target } = await seedDeveloperAndTarget();
    const now = new Date();
    const make = (data: { status: 'PENDING' | 'DELIVERED' | 'DONE' | 'EXPIRED'; createdAt: Date; completedAt?: Date | null }) =>
      prisma.agentCommand.create({
        data: {
          workspaceId: developer.workspaceId,
          userId: target.id,
          requestedById: developer.userId,
          type: 'RESYNC',
          params: { from: '2026-10-01', to: '2026-10-01' },
          ...data,
        },
      });
    const oldPending = await make({ status: 'PENDING', createdAt: new Date(now.getTime() - 8 * DAY) });
    const oldDelivered = await make({ status: 'DELIVERED', createdAt: new Date(now.getTime() - 8 * DAY) });
    const freshPending = await make({ status: 'PENDING', createdAt: new Date(now.getTime() - 2 * DAY) });
    const oldDone = await make({ status: 'DONE', createdAt: new Date(now.getTime() - 40 * DAY), completedAt: new Date(now.getTime() - 31 * DAY) });
    const recentDone = await make({ status: 'DONE', createdAt: new Date(now.getTime() - 20 * DAY), completedAt: new Date(now.getTime() - 20 * DAY) });
    const oldExpired = await make({ status: 'EXPIRED', createdAt: new Date(now.getTime() - 60 * DAY), completedAt: new Date(now.getTime() - 50 * DAY) });

    const result = await runPruneOnce(now);
    expect(result).toMatchObject({ agentCommandsExpired: 2, agentCommands: 2 });

    const status = async (id: string) => (await prisma.agentCommand.findUnique({ where: { id } }))?.status ?? null;
    expect(await status(oldPending.id)).toBe('EXPIRED');
    expect(await status(oldDelivered.id)).toBe('EXPIRED');
    expect(await status(freshPending.id)).toBe('PENDING');
    expect(await status(oldDone.id)).toBeNull();
    expect(await status(recentDone.id)).toBe('DONE');
    expect(await status(oldExpired.id)).toBeNull();
    // Just expired: kept for the developer page, deleted 30 days from now.
    const expired = await prisma.agentCommand.findUniqueOrThrow({ where: { id: oldPending.id } });
    expect(expired.completedAt).toEqual(now);

    // An expired command's late result is still recorded.
    const { signAccessToken } = await import('../src/lib/jwt');
    const targetToken = signAccessToken({ sub: target.id, ws: developer.workspaceId, role: 'MEMBER' });
    const late = await request(app)
      .post(`/v1/agent/commands/${oldPending.id}/result`)
      .set(bearer(targetToken))
      .send({ status: 'DONE', result: { late: true } });
    expect(late.body.alreadyCompleted).toBe(false);
    expect(await status(oldPending.id)).toBe('DONE');
  });
});
