import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { seedUser, iso } from './helpers';
import { setLarkMessengerForTests, type LarkMessenger, type SendCardResult } from '../src/lark';
import { processManualTimeLarkOutboxOnce } from '../src/manualTime/larkOutbox';
import { OUTBOX_STALE_LOCK_MS, staleOutboxLockCutoff } from '../src/lib/outboxReclaim';

/**
 * The manual-time Lark outbox must (a) pick back up a claim a dead worker left
 * PROCESSING, and (b) never post the approver a second card for a message that
 * already went out.
 */

const app = buildApp();
const T0 = Date.parse('2026-05-29T09:00:00.000Z');

class FakeMessenger implements LarkMessenger {
  sends: Array<{ receiveOpenId: string; uuid?: string }> = [];
  async sendCard(receiveOpenId: string, _card: Record<string, unknown>, uuid?: string): Promise<SendCardResult> {
    this.sends.push({ receiveOpenId, uuid });
    return { messageId: `om_outbox_${Date.now()}_${this.sends.length}` };
  }
  async sendCardToChat(): Promise<SendCardResult> { return { messageId: 'om_chat' }; }
  async updateCard(): Promise<void> {}
  async sendText(): Promise<SendCardResult> { return { messageId: 'om_txt' }; }
  async sendTextToChat(): Promise<SendCardResult> { return { messageId: 'om_txt_chat' }; }
}

let fake: FakeMessenger;
beforeEach(() => { fake = new FakeMessenger(); setLarkMessengerForTests(fake); });
afterAll(() => { setLarkMessengerForTests(null); });

let n = 0;
async function queueCard() {
  n += 1;
  const openId = `ou_outbox_${Date.now()}_${n}`;
  const requester = await seedUser({ role: 'MEMBER' });
  const admin = await prisma.user.create({
    data: {
      workspaceId: requester.workspaceId,
      email: `outbox-admin-${Date.now()}-${n}@test.local`,
      name: 'Approver',
      role: 'ADMIN',
      provisioningStatus: 'ACTIVE',
      passwordHash: 'x'.repeat(60),
    },
  });
  await prisma.larkIdentity.create({ data: { userId: admin.id, openId } });
  const res = await request(app)
    .post('/v1/time-requests')
    .set('Authorization', `Bearer ${requester.accessToken}`)
    .send({
      clientUuid: `cu_outbox_${Date.now()}_${n}`,
      requestedStart: iso(T0 + n * 3 * 60 * 60_000),
      requestedEnd: iso(T0 + n * 3 * 60 * 60_000 + 60 * 60_000),
      reason: 'Forgot to start the tracker',
    });
  expect(res.status).toBe(201);
  const event = await prisma.manualTimeLarkOutboxEvent.findFirstOrThrow({
    where: { requestId: res.body.id as string, kind: 'SEND_CARD' },
  });
  return { openId, event };
}

/** Drain until this event settles (other suites' leftovers share the table). */
async function drainUntilDone(eventId: string) {
  for (let i = 0; i < 20; i += 1) {
    await processManualTimeLarkOutboxOnce(50);
    const row = await prisma.manualTimeLarkOutboxEvent.findUniqueOrThrow({ where: { id: eventId } });
    if (row.status === 'DONE') return row;
  }
  return prisma.manualTimeLarkOutboxEvent.findUniqueOrThrow({ where: { id: eventId } });
}

const sendsTo = (openId: string) => fake.sends.filter((s) => s.receiveOpenId === openId);

describe('manual-time Lark outbox', () => {
  it('reclaims a claim abandoned for longer than the stale window', async () => {
    const { openId, event } = await queueCard();
    await prisma.manualTimeLarkOutboxEvent.update({
      where: { id: event.id },
      data: { status: 'PROCESSING', lockedAt: new Date(Date.now() - OUTBOX_STALE_LOCK_MS - 60_000), lockedBy: 'dead-worker' },
    });
    const done = await drainUntilDone(event.id);
    expect(done.status).toBe('DONE');
    expect(sendsTo(openId)).toHaveLength(1);
  });

  it('leaves a fresh claim alone — a live worker owns it', async () => {
    const { openId, event } = await queueCard();
    await prisma.manualTimeLarkOutboxEvent.update({
      where: { id: event.id },
      data: { status: 'PROCESSING', lockedAt: new Date(Date.now() - 60_000), lockedBy: 'live-worker' },
    });
    await processManualTimeLarkOutboxOnce(50);
    const row = await prisma.manualTimeLarkOutboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(row.status).toBe('PROCESSING');
    expect(row.lockedBy).toBe('live-worker');
    expect(sendsTo(openId)).toHaveLength(0);
  });

  it('does not send a second card when a delivered event runs again', async () => {
    const { openId, event } = await queueCard();
    await drainUntilDone(event.id);
    expect(sendsTo(openId)).toHaveLength(1);
    // The card went out, then the worker died before settling the event.
    await prisma.manualTimeLarkOutboxEvent.update({
      where: { id: event.id },
      data: { status: 'PENDING', processedAt: null, nextRunAt: new Date(Date.now() - 1000) },
    });
    const again = await drainUntilDone(event.id);
    expect(again.status).toBe('DONE');
    expect(sendsTo(openId)).toHaveLength(1);
  });

  it('hands Lark the ledger id as the idempotency key', async () => {
    const { openId, event } = await queueCard();
    await drainUntilDone(event.id);
    expect(sendsTo(openId)[0]?.uuid).toBe(event.messageLedgerId);
  });

  it('computes the stale cutoff from the window', () => {
    const now = new Date('2026-10-05T12:00:00.000Z');
    expect(staleOutboxLockCutoff(now).toISOString()).toBe('2026-10-05T11:55:00.000Z');
  });
});
