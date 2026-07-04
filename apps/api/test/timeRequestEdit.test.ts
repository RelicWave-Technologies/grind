import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { seedUser } from './helpers';
import { setLarkMessengerForTests, type LarkMessenger, type SendCardResult } from '../src/lark';
import { processManualTimeLarkOutboxOnce } from '../src/manualTime/larkOutbox';

/**
 * Integration tests for PATCH /v1/time-requests/:id and POST :id/cancel.
 * Real Postgres + FakeMessenger captures so we can assert the queued Lark side
 * without hitting Lark.
 */

const app = buildApp();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

class FakeMessenger implements LarkMessenger {
  sends: Array<{ receiveOpenId: string; card: Record<string, unknown> }> = [];
  updates: Array<{ messageId: string; card: Record<string, unknown> }> = [];
  texts: Array<{ receiveOpenId: string; text: string }> = [];
  async sendCard(receiveOpenId: string, card: Record<string, unknown>): Promise<SendCardResult> {
    this.sends.push({ receiveOpenId, card });
    return { messageId: `om_${this.sends.length}` };
  }
  async updateCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    this.updates.push({ messageId, card });
  }
  async sendText(receiveOpenId: string, text: string): Promise<SendCardResult> {
    this.texts.push({ receiveOpenId, text });
    return { messageId: `om_txt_${this.texts.length}` };
  }
}

let fake: FakeMessenger;
beforeEach(() => {
  fake = new FakeMessenger();
  setLarkMessengerForTests(fake);
});
afterAll(() => setLarkMessengerForTests(null));

async function seedWorkspaceWithApprover() {
  const requester = await seedUser({ role: 'MEMBER' });
  const approver = await prisma.user.create({
    data: {
      workspaceId: requester.workspaceId,
      email: `appr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`,
      name: 'Approver Alice',
      role: 'ADMIN',
      passwordHash: 'x'.repeat(60),
    },
  });
  const openId = `ou_appr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await prisma.larkIdentity.create({ data: { userId: approver.id, openId } });
  return { requester, approver, openId };
}

async function createRequest(userId: string, opts: { status?: 'PENDING' | 'APPROVED' | 'CANCELLED'; larkMessageId?: string } = {}) {
  return prisma.manualTimeRequest.create({
    data: {
      clientUuid: `mtr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      userId,
      requestedStart: new Date('2026-05-20T09:00:00Z'),
      requestedEnd: new Date('2026-05-20T10:30:00Z'),
      reason: 'forgot to start',
      status: opts.status ?? 'PENDING',
      larkMessageId: opts.larkMessageId ?? null,
    },
  });
}

describe('PATCH /v1/time-requests/:id — happy path', () => {
  it('updates reason + task snapshot + range on a PENDING request', async () => {
    const { requester } = await seedWorkspaceWithApprover();
    const req = await createRequest(requester.userId);
    const res = await request(app)
      .patch(`/v1/time-requests/${req.id}`)
      .set(bearer(requester.accessToken))
      .send({
        reason: 'updated reason after lunch',
        larkTaskGuid: 'task_X',
        taskSummary: 'Task X rollout',
        requestedEnd: '2026-05-20T11:00:00.000Z',
      });
    expect(res.status).toBe(200);
    expect(res.body.reason).toBe('updated reason after lunch');
    expect(res.body.larkTaskGuid).toBe('task_X');
    expect(res.body.taskSummary).toBe('Task X rollout');
    expect(new Date(res.body.requestedEnd).toISOString()).toBe('2026-05-20T11:00:00.000Z');

    const fresh = await prisma.manualTimeRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(fresh.reason).toBe('updated reason after lunch');
    expect(fresh.taskSummary).toBe('Task X rollout');
  });

  it('disables the previous card and sends a NEW card with the updated values + diff', async () => {
    const { requester, approver, openId } = await seedWorkspaceWithApprover();
    // First, POST a real request so the Lark card lands and we get a larkMessageId.
    const created = await request(app)
      .post('/v1/time-requests')
      .set(bearer(requester.accessToken))
      .send({
        clientUuid: `cu_${Date.now()}`,
        requestedStart: '2026-05-20T09:00:00.000Z',
        requestedEnd: '2026-05-20T10:00:00.000Z',
        reason: 'initial reason',
      });
    expect(created.status).toBe(201);
    expect(fake.sends.length).toBe(0);
    await processManualTimeLarkOutboxOnce();
    expect(fake.sends.length).toBe(1);
    expect(fake.sends[0]!.receiveOpenId).toBe(openId);
    const id = created.body.id;
    expect(created.body.larkMessageId).toBeNull();
    void approver;

    // Now PATCH the reason.
    const patched = await request(app)
      .patch(`/v1/time-requests/${id}`)
      .set(bearer(requester.accessToken))
      .send({ reason: 'updated explanation' });
    expect(patched.status).toBe(200);
    expect(patched.body.version).toBe(2);

    // PATCH only queues Lark work; the outbox then sends the new card and
    // disables older known cards.
    expect(fake.sends.length).toBe(1);
    expect(fake.updates.length).toBe(0);
    await processManualTimeLarkOutboxOnce();

    // The old card (om_1) is updated to a stale variant (no buttons).
    expect(fake.updates.length).toBe(1);
    expect(fake.updates[0]!.messageId).toBe('om_1');
    const supersededJson = JSON.stringify(fake.updates[0]!.card);
    expect(supersededJson).toContain('stale');
    // No action buttons on the superseded card.
    expect(supersededJson).not.toContain('"action":"approve"');
    expect(supersededJson).not.toContain('"action":"reject"');

    // A NEW card was sent (the second sendCard call), to the same approver,
    // and it carries the new reason + the diff section.
    expect(fake.sends.length).toBe(2);
    expect(fake.sends[1]!.receiveOpenId).toBe(openId);
    const updatedJson = JSON.stringify(fake.sends[1]!.card);
    expect(updatedJson).toContain('updated explanation');
    expect(updatedJson).toContain('What changed');
    expect(updatedJson).toContain('initial reason'); // the "before"
    // The new card has buttons again.
    expect(updatedJson).toContain('approve');

    // DB's larkMessageId points at the NEW card so future edits/cancels
    // act on it instead of the (now-superseded) original.
    const fresh = await prisma.manualTimeRequest.findUniqueOrThrow({ where: { id } });
    expect(fresh.larkMessageId).toBe('om_2');
    // No plain-text nudge anymore — the new card itself carries the news.
    expect(fake.texts.length).toBe(0);
  });

  it('does not send the original actionable card if the request is edited before the outbox drains', async () => {
    const { requester, openId } = await seedWorkspaceWithApprover();
    const created = await request(app)
      .post('/v1/time-requests')
      .set(bearer(requester.accessToken))
      .send({
        clientUuid: `cu_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        requestedStart: '2026-05-20T09:00:00.000Z',
        requestedEnd: '2026-05-20T10:00:00.000Z',
        reason: 'initial reason',
      });
    expect(created.status).toBe(201);
    expect(fake.sends.length).toBe(0);

    const patched = await request(app)
      .patch(`/v1/time-requests/${created.body.id}`)
      .set(bearer(requester.accessToken))
      .send({ reason: 'updated before first send' });
    expect(patched.status).toBe(200);

    await processManualTimeLarkOutboxOnce();
    expect(fake.sends.length).toBe(1);
    expect(fake.sends[0]!.receiveOpenId).toBe(openId);
    const sentJson = JSON.stringify(fake.sends[0]!.card);
    expect(sentJson).toContain('updated before first send');
    expect(sentJson).toContain('What changed');

    const messages = await prisma.manualTimeLarkMessage.findMany({
      where: { requestId: created.body.id },
      orderBy: { version: 'asc' },
    });
    expect(messages.map((m) => m.status)).toEqual(['SUPERSEDED', 'SENT']);
  });
});

describe('PATCH /v1/time-requests/:id — invariants', () => {
  it('401 without auth', async () => {
    const res = await request(app).patch('/v1/time-requests/x').send({ reason: 'y' });
    expect(res.status).toBe(401);
  });

  it("403 when patching someone else's request", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const req = await createRequest(owner.userId);
    const res = await request(app)
      .patch(`/v1/time-requests/${req.id}`)
      .set(bearer(stranger.accessToken))
      .send({ reason: 'sneaky' });
    expect(res.status).toBe(403);
  });

  it('409 when the request is already decided (APPROVED)', async () => {
    const u = await seedUser();
    const req = await createRequest(u.userId, { status: 'APPROVED' });
    const res = await request(app)
      .patch(`/v1/time-requests/${req.id}`)
      .set(bearer(u.accessToken))
      .send({ reason: 'cannot' });
    expect(res.status).toBe(409);
  });

  it('400 when patching to an invalid range (end <= start)', async () => {
    const u = await seedUser();
    const req = await createRequest(u.userId);
    const res = await request(app)
      .patch(`/v1/time-requests/${req.id}`)
      .set(bearer(u.accessToken))
      .send({ requestedEnd: '2026-05-19T09:00:00.000Z' });
    expect(res.status).toBe(400);
  });

  it('400 with no fields (must change something)', async () => {
    const u = await seedUser();
    const req = await createRequest(u.userId);
    const res = await request(app)
      .patch(`/v1/time-requests/${req.id}`)
      .set(bearer(u.accessToken))
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/time-requests/:id/cancel', () => {
  it('marks a PENDING request CANCELLED with the user as decider', async () => {
    const u = await seedUser();
    const req = await createRequest(u.userId);
    const res = await request(app).post(`/v1/time-requests/${req.id}/cancel`).set(bearer(u.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');
    expect(res.body.decidedAt).not.toBeNull();
    expect(res.body.decidedReason).toBe('Cancelled by requester');

    const fresh = await prisma.manualTimeRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(fresh.status).toBe('CANCELLED');
  });

  it('409 on an already-decided request', async () => {
    const u = await seedUser();
    const req = await createRequest(u.userId, { status: 'APPROVED' });
    const res = await request(app).post(`/v1/time-requests/${req.id}/cancel`).set(bearer(u.accessToken));
    expect(res.status).toBe(409);
  });

  it("403 when cancelling someone else's request", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const req = await createRequest(owner.userId);
    const res = await request(app).post(`/v1/time-requests/${req.id}/cancel`).set(bearer(stranger.accessToken));
    expect(res.status).toBe(403);
  });

  it('rewrites the Lark card to a withdrawn variant with NO Approve/Reject buttons', async () => {
    const { requester, openId } = await seedWorkspaceWithApprover();
    const created = await request(app)
      .post('/v1/time-requests')
      .set(bearer(requester.accessToken))
      .send({
        clientUuid: `cu_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        requestedStart: '2026-05-20T09:00:00.000Z',
        requestedEnd: '2026-05-20T10:00:00.000Z',
        reason: 'initial',
      });
    expect(created.status).toBe(201);
    void openId; // delivered to the approver via the initial sendCard
    await processManualTimeLarkOutboxOnce();

    const cancelled = await request(app).post(`/v1/time-requests/${created.body.id}/cancel`).set(bearer(requester.accessToken));
    expect(cancelled.status).toBe(200);
    expect(fake.updates.length).toBe(0);
    await processManualTimeLarkOutboxOnce();

    // The original card (om_1) was rewritten with the withdrawn variant:
    // red header, no Approve/Reject buttons, "withdrawn by requester" note.
    expect(fake.updates.length).toBe(1);
    expect(fake.updates[0]!.messageId).toBe('om_1');
    const withdrawnJson = JSON.stringify(fake.updates[0]!.card);
    expect(withdrawnJson).toContain('withdrawn');
    expect(withdrawnJson).not.toContain('"action":"approve"');
    expect(withdrawnJson).not.toContain('"action":"reject"');
    // No extra text nudge — the rewritten card carries the news on its own.
    expect(fake.texts.length).toBe(0);
  });

  it('does not send an actionable card if the request is cancelled before the outbox drains', async () => {
    const { requester } = await seedWorkspaceWithApprover();
    const created = await request(app)
      .post('/v1/time-requests')
      .set(bearer(requester.accessToken))
      .send({
        clientUuid: `cu_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        requestedStart: '2026-05-20T09:00:00.000Z',
        requestedEnd: '2026-05-20T10:00:00.000Z',
        reason: 'initial',
      });
    expect(created.status).toBe(201);

    const cancelled = await request(app).post(`/v1/time-requests/${created.body.id}/cancel`).set(bearer(requester.accessToken));
    expect(cancelled.status).toBe(200);
    await processManualTimeLarkOutboxOnce();

    expect(fake.sends.length).toBe(0);
    expect(fake.updates.length).toBe(0);
    const message = await prisma.manualTimeLarkMessage.findFirstOrThrow({ where: { requestId: created.body.id } });
    expect(message.status).toBe('CANCELLED');
  });
});
