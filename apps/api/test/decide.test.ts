import { describe, it, expect } from 'vitest';
import { ulid } from 'ulid';
import { prisma } from '@grind/db';
import { decideRequest } from '../src/lark/decide';
import { seedUser } from './helpers';

/**
 * Real Postgres tests for the decide path. No mocks — we build a real
 * ManualTimeRequest with a real approver + LarkIdentity, then call
 * decideRequest and assert the DB state + card payload.
 */

let openIdCounter = 0;
async function setup(opts: { approverOpenId?: string | null } = {}) {
  const openId = opts.approverOpenId === null ? null : opts.approverOpenId ?? `ou_decider_${Date.now()}_${++openIdCounter}`;
  const requester = await seedUser({ role: 'MEMBER' });
  const admin = await prisma.user.create({
    data: {
      workspaceId: requester.workspaceId,
      email: `dec-admin-${Date.now()}-${openIdCounter}@test.local`,
      name: 'Decider Dave',
      role: 'ADMIN',
      passwordHash: 'x'.repeat(60),
    },
  });
  if (openId) await prisma.larkIdentity.create({ data: { userId: admin.id, openId } });
  const start = new Date('2026-05-29T09:00:00.000Z');
  const end = new Date('2026-05-29T10:30:00.000Z');
  const requesterUser = await prisma.user.findUniqueOrThrow({ where: { id: requester.userId } });
  const req = await prisma.manualTimeRequest.create({
    data: {
      clientUuid: `cu_dec_${openIdCounter}`,
      userId: requester.userId,
      approverId: admin.id,
      larkTaskGuid: 'guid-T',
      requestedStart: start,
      requestedEnd: end,
      reason: 'Forgot to start tracker',
      status: 'PENDING',
    },
  });
  const card = openId
    ? await prisma.manualTimeLarkMessage.create({
        data: {
          requestId: req.id,
          version: req.version,
          recipientOpenId: openId,
          messageId: `om_dec_${ulid()}`,
          kind: 'APPROVAL',
          status: 'SENT',
        },
      })
    : null;
  return { requester: requesterUser, admin, req, openId, card };
}

function click(req: { id: string; version: number }, card: { id: string; version: number } | null, openId: string) {
  return {
    requestId: req.id,
    cardId: card?.id,
    version: card?.version ?? req.version,
    decidedByOpenId: openId,
  };
}

describe('decideRequest — APPROVE', () => {
  it('flips status to APPROVED, creates a real TimeEntry(MANUAL), returns a green decided card', async () => {
    const { admin, req, openId, card } = await setup();
    const result = await decideRequest({ ...click(req, card, openId!), action: 'approve' });
    expect(result).not.toBeNull();
    expect(result!.status).toBe('APPROVED');
    expect(result!.timeEntryId).toBeTruthy();
    expect(result!.noop).toBeNull();

    // Real DB state
    const row = await prisma.manualTimeRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.status).toBe('APPROVED');
    expect(row.decidedAt).not.toBeNull();
    expect(row.timeEntryId).toBe(result!.timeEntryId);

    const te = await prisma.timeEntry.findUniqueOrThrow({ where: { id: result!.timeEntryId! }, include: { segments: true } });
    expect(te.source).toBe('MANUAL');
    expect(te.startedAt.toISOString()).toBe(req.requestedStart.toISOString());
    expect(te.endedAt!.toISOString()).toBe(req.requestedEnd.toISOString());
    expect(te.larkTaskGuid).toBe('guid-T');
    expect(te.segments).toHaveLength(1);
    expect(te.segments[0]!.kind).toBe('WORK');

    // Card reflects the decision
    expect((result!.card.header as Record<string, unknown>).template).toBe('green');
    expect(JSON.stringify(result!.card)).toContain('Approved');
    expect(JSON.stringify(result!.card)).toContain(admin.name);
  });
});

describe('decideRequest — attendees', () => {
  it('carries the request attendees (meeting participants) onto the approved TimeEntry', async () => {
    const { requester, req, openId, card } = await setup();
    const mk = (tag: string) =>
      prisma.user.create({
        data: {
          workspaceId: requester.workspaceId,
          email: `${tag}-${ulid()}@test.local`,
          name: tag,
          role: 'MEMBER',
          passwordHash: 'x'.repeat(60),
        },
      });
    const a1 = await mk('att1');
    const a2 = await mk('att2');
    await prisma.mtrAttendee.createMany({
      data: [
        { requestId: req.id, userId: a1.id },
        { requestId: req.id, userId: a2.id },
      ],
    });

    const result = await decideRequest({ ...click(req, card, openId!), action: 'approve' });
    expect(result!.status).toBe('APPROVED');
    const teAttendees = await prisma.timeEntryAttendee.findMany({ where: { timeEntryId: result!.timeEntryId! } });
    expect(teAttendees.map((a) => a.userId).sort()).toEqual([a1.id, a2.id].sort());
  });
});

describe('decideRequest — REJECT', () => {
  it('flips status to REJECTED, does NOT create a TimeEntry, returns a red decided card', async () => {
    const { req, openId, card } = await setup();
    const result = await decideRequest({ ...click(req, card, openId!), action: 'reject' });
    expect(result!.status).toBe('REJECTED');
    expect(result!.timeEntryId).toBeNull();

    const row = await prisma.manualTimeRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.status).toBe('REJECTED');
    expect(row.timeEntryId).toBeNull();
    expect(await prisma.timeEntry.count()).toBe(0); // no TimeEntry was created

    expect((result!.card.header as Record<string, unknown>).template).toBe('red');
  });
});

describe('decideRequest — idempotency', () => {
  it('a second click on an already-approved card is a no-op (status preserved, no duplicate entry)', async () => {
    const { req, openId, card } = await setup();
    const first = await decideRequest({ ...click(req, card, openId!), action: 'approve' });
    expect(first!.status).toBe('APPROVED');
    const firstTeId = first!.timeEntryId;

    const second = await decideRequest({ ...click(req, card, openId!), action: 'reject' });
    expect(second!.status).toBe('APPROVED'); // unchanged
    expect(second!.noop).toBe('already_decided');
    expect(second!.timeEntryId).toBe(firstTeId); // same TimeEntry, no duplicate

    // Exactly one TimeEntry exists.
    expect(await prisma.timeEntry.count()).toBe(1);
  });
});

describe('decideRequest — stale cards and races', () => {
  it('does not decide when an old card version is clicked after an edit', async () => {
    const { req, openId, card } = await setup();
    await prisma.manualTimeRequest.update({
      where: { id: req.id },
      data: { version: { increment: 1 }, reason: 'edited reason' },
    });

    const result = await decideRequest({ ...click(req, card, openId!), action: 'approve' });
    expect(result!.noop).toBe('stale_card');
    expect(result!.status).toBe('PENDING');
    expect(JSON.stringify(result!.card)).toContain('stale');

    const row = await prisma.manualTimeRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.status).toBe('PENDING');
    expect(row.timeEntryId).toBeNull();
    expect(await prisma.timeEntry.count()).toBe(0);
    const staleCard = await prisma.manualTimeLarkMessage.findUniqueOrThrow({ where: { id: card!.id } });
    expect(staleCard.status).toBe('STALE');
  });

  it('serializes approve/reject races into one final state without duplicate time', async () => {
    const { req, openId, card } = await setup();
    const [a, b] = await Promise.all([
      decideRequest({ ...click(req, card, openId!), action: 'approve' }),
      decideRequest({ ...click(req, card, openId!), action: 'reject' }),
    ]);
    const row = await prisma.manualTimeRequest.findUniqueOrThrow({ where: { id: req.id } });

    expect(['APPROVED', 'REJECTED']).toContain(row.status);
    expect(a!.status).toBe(row.status);
    expect(b!.status).toBe(row.status);
    expect(await prisma.timeEntry.count({ where: { clientUuid: `mtr-${req.id}` } })).toBe(row.status === 'APPROVED' ? 1 : 0);
  });
});

describe('decideRequest — cancelled requests', () => {
  it('returns a cancelled card, not a rejected decision card', async () => {
    const { req, openId, card } = await setup();
    await prisma.manualTimeRequest.update({
      where: { id: req.id },
      data: { status: 'CANCELLED', decidedAt: new Date('2026-05-29T11:00:00.000Z') },
    });

    const result = await decideRequest({ ...click(req, card, openId!), action: 'approve' });
    expect(result!.status).toBe('CANCELLED');
    expect(result!.noop).toBe('cancelled');
    expect(result!.timeEntryId).toBeNull();
    expect(JSON.stringify(result!.card)).toContain('Manual time request — withdrawn');
    expect(JSON.stringify(result!.card)).not.toContain('Time rejected');
    expect(await prisma.timeEntry.count()).toBe(0);
  });
});

describe('decideRequest — authorization', () => {
  it('rejects a decider whose open_id is not the assigned approver', async () => {
    const { req, card } = await setup({ approverOpenId: 'ou_approver_A' });
    const result = await decideRequest({ ...click(req, card, 'ou_someone_else'), action: 'approve' });
    expect(result!.noop).toBe('forbidden');

    const row = await prisma.manualTimeRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.status).toBe('PENDING'); // not touched
  });

  it('rejects when the approver has no Lark identity (no decider can match)', async () => {
    const { req } = await setup({ approverOpenId: null });
    const result = await decideRequest({ requestId: req.id, action: 'approve', decidedByOpenId: 'ou_anything' });
    expect(result!.noop).toBe('forbidden');
  });

  it('allows self-assigned admin cards when the open_id matches', async () => {
    const openId = `ou_self_${Date.now()}`;
    const requester = await seedUser({ role: 'ADMIN' });
    await prisma.larkIdentity.create({ data: { userId: requester.userId, openId } });
    const req = await prisma.manualTimeRequest.create({
      data: {
        clientUuid: `cu_self_${Date.now()}`,
        userId: requester.userId,
        approverId: requester.userId,
        requestedStart: new Date('2026-05-29T13:00:00.000Z'),
        requestedEnd: new Date('2026-05-29T14:00:00.000Z'),
        reason: 'Old self-assigned request',
        status: 'PENDING',
      },
    });
    const card = await prisma.manualTimeLarkMessage.create({
      data: {
        requestId: req.id,
        version: req.version,
        recipientOpenId: openId,
        messageId: `om_self_${ulid()}`,
        kind: 'APPROVAL',
        status: 'SENT',
      },
    });

    const result = await decideRequest({ ...click(req, card, openId), action: 'approve' });
    expect(result!.noop).toBeNull();
    expect(result!.status).toBe('APPROVED');
    const row = await prisma.manualTimeRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.status).toBe('APPROVED');
    expect(row.timeEntryId).toBeTruthy();
  });

  it('still rejects self-assigned member cards even when the open_id matches', async () => {
    const openId = `ou_member_self_${Date.now()}`;
    const requester = await seedUser({ role: 'MEMBER' });
    await prisma.larkIdentity.create({ data: { userId: requester.userId, openId } });
    const req = await prisma.manualTimeRequest.create({
      data: {
        clientUuid: `cu_member_self_${Date.now()}`,
        userId: requester.userId,
        approverId: requester.userId,
        requestedStart: new Date('2026-05-29T15:00:00.000Z'),
        requestedEnd: new Date('2026-05-29T16:00:00.000Z'),
        reason: 'Member self-assigned request',
        status: 'PENDING',
      },
    });
    const card = await prisma.manualTimeLarkMessage.create({
      data: {
        requestId: req.id,
        version: req.version,
        recipientOpenId: openId,
        messageId: `om_member_self_${ulid()}`,
        kind: 'APPROVAL',
        status: 'SENT',
      },
    });

    const result = await decideRequest({ ...click(req, card, openId), action: 'approve' });
    expect(result!.noop).toBe('self_approval_forbidden');
    expect(result!.status).toBe('PENDING');
    const row = await prisma.manualTimeRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.status).toBe('PENDING');
    expect(row.timeEntryId).toBeNull();
  });
});

describe('decideRequest — missing request', () => {
  it('returns null for an unknown requestId', async () => {
    const result = await decideRequest({ requestId: 'does_not_exist', action: 'approve', decidedByOpenId: 'ou_x' });
    expect(result).toBeNull();
  });
});
