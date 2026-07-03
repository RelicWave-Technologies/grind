import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { seedUser, iso } from './helpers';
import { setLarkMessengerForTests, type LarkMessenger, type SendCardResult } from '../src/lark';

let app: Express;
beforeAll(() => { app = buildApp(); });

const T0 = Date.parse('2026-05-29T09:00:00.000Z');
const T1 = T0 + 90 * 60_000;

class FakeMessenger implements LarkMessenger {
  sends: Array<{ receiveOpenId: string; card: Record<string, unknown> }> = [];
  updates: Array<{ messageId: string; card: Record<string, unknown> }> = [];
  texts: Array<{ receiveOpenId: string; text: string }> = [];
  failNextSend = false;
  failNextUpdate = false;
  async sendCard(receiveOpenId: string, card: Record<string, unknown>): Promise<SendCardResult> {
    if (this.failNextSend) { this.failNextSend = false; throw new Error('lark network down'); }
    this.sends.push({ receiveOpenId, card });
    return { messageId: `om_fake_${this.sends.length}` };
  }
  async updateCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    if (this.failNextUpdate) { this.failNextUpdate = false; throw new Error('lark network down'); }
    this.updates.push({ messageId, card });
  }
  async sendText(receiveOpenId: string, text: string): Promise<SendCardResult> {
    this.texts.push({ receiveOpenId, text });
    return { messageId: `om_txt_${this.texts.length}` };
  }
}

let fake: FakeMessenger;
beforeEach(() => { fake = new FakeMessenger(); setLarkMessengerForTests(fake); });
afterAll(() => { setLarkMessengerForTests(null); });

let approverCounter = 0;
/** Seed a workspace with a MEMBER (requester) and an ADMIN (approver) with a Lark identity. */
async function seedWorkspaceWithApprover(approverOpenId: string | null | undefined = undefined) {
  if (approverOpenId === undefined) approverOpenId = `ou_admin_${Date.now()}_${++approverCounter}`;
  const requester = await seedUser({ role: 'MEMBER' });
  const admin = await prisma.user.create({
    data: {
      workspaceId: requester.workspaceId,
      email: `admin-${Date.now()}@test.local`,
      name: 'Manager Mira',
      role: 'ADMIN',
      passwordHash: 'x'.repeat(60),
    },
  });
  if (approverOpenId) {
    await prisma.larkIdentity.create({ data: { userId: admin.id, openId: approverOpenId } });
  }
  return { requester, admin };
}

async function seedWorkspaceWithManagerApprover(managerOpenId = `ou_manager_${Date.now()}_${++approverCounter}`) {
  const requester = await seedUser({ role: 'MEMBER' });
  const admin = await prisma.user.create({
    data: {
      workspaceId: requester.workspaceId,
      email: `admin-${Date.now()}@test.local`,
      name: 'Admin Ada',
      role: 'ADMIN',
      passwordHash: 'x'.repeat(60),
    },
  });
  const manager = await prisma.user.create({
    data: {
      workspaceId: requester.workspaceId,
      email: `manager-${Date.now()}@test.local`,
      name: 'Manager Mira',
      role: 'MANAGER',
      passwordHash: 'x'.repeat(60),
    },
  });
  await prisma.user.update({ where: { id: requester.userId }, data: { managerId: manager.id } });
  await prisma.larkIdentity.create({ data: { userId: manager.id, openId: managerOpenId } });
  return { requester, admin, manager, managerOpenId };
}

function body(over: Partial<Record<string, unknown>> = {}) {
  return {
    clientUuid: `cu_${Math.random().toString(36).slice(2)}`,
    requestedStart: iso(T0),
    requestedEnd: iso(T1),
    reason: 'Forgot to start tracker after standup',
    ...over,
  };
}

describe('POST /v1/time-requests — submit', () => {
  it('401 without a token', async () => {
    const res = await request(app).post('/v1/time-requests').send(body());
    expect(res.status).toBe(401);
  });

  it('creates a PENDING request and sends a card to the approver', async () => {
    const openId = `ou_admin_X_${Date.now()}`;
    const { requester, admin } = await seedWorkspaceWithApprover(openId);
    const b = body({ larkTaskGuid: 'guid-T', taskSummary: 'Ship M10' });
    const res = await request(app)
      .post('/v1/time-requests')
      .set('Authorization', `Bearer ${requester.accessToken}`)
      .send(b);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'PENDING',
      userId: requester.userId,
      approverId: admin.id,
      larkTaskGuid: 'guid-T',
      taskSummary: 'Ship M10',
      reason: b.reason,
    });
    expect(res.body.larkMessageId).toBe('om_fake_1');

    // Real DB has the row, status PENDING, with the messageId persisted.
    const row = await prisma.manualTimeRequest.findUnique({ where: { id: res.body.id } });
    expect(row).not.toBeNull();
    expect(row!.status).toBe('PENDING');
    expect(row!.taskSummary).toBe('Ship M10');
    expect(row!.larkMessageId).toBe('om_fake_1');

    // The messenger was called with the admin's open_id and a real card payload.
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]!.receiveOpenId).toBe(openId);
    // Card body carries the requestId in a button value, and the requester name + reason in fields.
    const json = JSON.stringify(fake.sends[0]!.card);
    expect(json).toContain(res.body.id);
    expect(json).toContain('Ship M10');
    expect(json).toContain(b.reason);
  });

  it('routes a member request to their direct manager before admin fallback', async () => {
    const { requester, admin, manager, managerOpenId } = await seedWorkspaceWithManagerApprover();
    const res = await request(app)
      .post('/v1/time-requests')
      .set('Authorization', `Bearer ${requester.accessToken}`)
      .send(body());
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.approverId).toBe(manager.id);
    expect(res.body.approverId).not.toBe(admin.id);
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]!.receiveOpenId).toBe(managerOpenId);
  });

  it('is idempotent on clientUuid (second POST returns 200 same row)', async () => {
    const { requester } = await seedWorkspaceWithApprover();
    const b = body();
    const first = await request(app).post('/v1/time-requests').set('Authorization', `Bearer ${requester.accessToken}`).send(b);
    expect(first.status).toBe(201);
    const second = await request(app).post('/v1/time-requests').set('Authorization', `Bearer ${requester.accessToken}`).send(b);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(fake.sends).toHaveLength(1); // didn't re-send the card on retry
  });

  it('409 on clientUuid conflict from a different user', async () => {
    const { requester: r1 } = await seedWorkspaceWithApprover();
    const { requester: r2 } = await seedWorkspaceWithApprover();
    const b = body();
    const first = await request(app).post('/v1/time-requests').set('Authorization', `Bearer ${r1.accessToken}`).send(b);
    expect(first.status).toBe(201);
    const collision = await request(app).post('/v1/time-requests').set('Authorization', `Bearer ${r2.accessToken}`).send(b);
    expect(collision.status).toBe(409);
  });

  it('400 invalid_range when end <= start', async () => {
    const { requester } = await seedWorkspaceWithApprover();
    const res = await request(app)
      .post('/v1/time-requests')
      .set('Authorization', `Bearer ${requester.accessToken}`)
      .send(body({ requestedEnd: iso(T0) }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_range');
  });

  it('400 no_approver when no admin exists in the workspace', async () => {
    const requester = await seedUser({ role: 'MEMBER' });
    const res = await request(app)
      .post('/v1/time-requests')
      .set('Authorization', `Bearer ${requester.accessToken}`)
      .send(body());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('no_approver');
  });

  it('still creates the row when approver has no Lark identity (no message sent)', async () => {
    const { requester } = await seedWorkspaceWithApprover(null); // no LarkIdentity on admin
    const res = await request(app).post('/v1/time-requests').set('Authorization', `Bearer ${requester.accessToken}`).send(body());
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.larkMessageId).toBeNull();
    expect(fake.sends).toHaveLength(0);
  });

  it('treats Lark send failure as non-fatal — request still PENDING, no larkMessageId', async () => {
    const { requester } = await seedWorkspaceWithApprover();
    fake.failNextSend = true;
    const res = await request(app).post('/v1/time-requests').set('Authorization', `Bearer ${requester.accessToken}`).send(body());
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.larkMessageId).toBeNull();
  });
});

describe('GET /v1/time-requests — list', () => {
  it('default role=mine returns the caller\'s submissions', async () => {
    const { requester } = await seedWorkspaceWithApprover();
    await request(app).post('/v1/time-requests').set('Authorization', `Bearer ${requester.accessToken}`).send(body());
    await request(app).post('/v1/time-requests').set('Authorization', `Bearer ${requester.accessToken}`).send(body());
    const res = await request(app).get('/v1/time-requests').set('Authorization', `Bearer ${requester.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.requests).toHaveLength(2);
    for (const r of res.body.requests) expect(r.userId).toBe(requester.userId);
  });

  it('role=approvals returns where caller is approver', async () => {
    const { requester, admin } = await seedWorkspaceWithApprover();
    await request(app).post('/v1/time-requests').set('Authorization', `Bearer ${requester.accessToken}`).send(body());
    const adminToken = (await import('../src/lib/jwt')).signAccessToken({ sub: admin.id, ws: requester.workspaceId, role: 'ADMIN' });
    const res = await request(app).get('/v1/time-requests?role=approvals').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.requests).toHaveLength(1);
    expect(res.body.requests[0].approverId).toBe(admin.id);
  });

  it('filters by status', async () => {
    const { requester } = await seedWorkspaceWithApprover();
    const r = await request(app).post('/v1/time-requests').set('Authorization', `Bearer ${requester.accessToken}`).send(body());
    // Promote one row to APPROVED via direct DB write (decide path tested elsewhere).
    await prisma.manualTimeRequest.update({ where: { id: r.body.id }, data: { status: 'APPROVED', decidedAt: new Date() } });

    const pending = await request(app).get('/v1/time-requests?status=PENDING').set('Authorization', `Bearer ${requester.accessToken}`);
    expect(pending.body.requests).toHaveLength(0);
    const approved = await request(app).get('/v1/time-requests?status=APPROVED').set('Authorization', `Bearer ${requester.accessToken}`);
    expect(approved.body.requests).toHaveLength(1);
  });

  it('filters the caller submissions by local-day range and returns people summaries', async () => {
    const { requester, admin } = await seedWorkspaceWithApprover();
    const inRange = await request(app)
      .post('/v1/time-requests')
      .set('Authorization', `Bearer ${requester.accessToken}`)
      .send(body({ clientUuid: 'cu-in-range', larkTaskGuid: 'task-in-range', taskSummary: 'Write launch notes' }));
    await request(app)
      .post('/v1/time-requests')
      .set('Authorization', `Bearer ${requester.accessToken}`)
      .send(body({
        clientUuid: 'cu-out-range',
        requestedStart: '2026-06-03T09:00:00.000Z',
        requestedEnd: '2026-06-03T10:00:00.000Z',
      }));

    const res = await request(app)
      .get('/v1/time-requests?from=2026-05-29&to=2026-05-29&tz=UTC')
      .set('Authorization', `Bearer ${requester.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ from: '2026-05-29', to: '2026-05-29', tz: 'UTC' });
    expect(res.body.requests).toHaveLength(1);
    expect(res.body.requests[0].id).toBe(inRange.body.id);
    expect(res.body.requests[0].taskSummary).toBe('Write launch notes');
    expect(res.body.requests[0].user).toMatchObject({ id: requester.userId });
    expect(res.body.requests[0].approver).toMatchObject({ id: admin.id, name: 'Manager Mira' });
  });

  it('rejects invalid self-list ranges', async () => {
    const { requester } = await seedWorkspaceWithApprover();
    const inverted = await request(app)
      .get('/v1/time-requests?from=2026-06-02&to=2026-06-01&tz=UTC')
      .set('Authorization', `Bearer ${requester.accessToken}`);
    expect(inverted.status).toBe(400);
    expect(inverted.body.error).toBe('invalid_range');

    const tooLong = await request(app)
      .get('/v1/time-requests?from=2026-01-01&to=2026-03-15&tz=UTC')
      .set('Authorization', `Bearer ${requester.accessToken}`);
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error).toBe('range_too_long');
  });
});
