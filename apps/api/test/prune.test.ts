import { describe, it, expect } from 'vitest';
import { prisma } from '@grind/db';
import {
  prunePredicates,
  runPruneOnce,
  REFRESH_TOKEN_RETENTION_MS,
  OUTBOX_DONE_RETENTION_MS,
  LARK_MESSAGE_TERMINAL_RETENTION_MS,
} from '../src/maintenance/prune';
import { seedUser } from './helpers';

const NOW = new Date('2026-10-05T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const DAY = 24 * 60 * 60_000;

let n = 0;
const uniq = (p: string) => `${p}_${Date.now()}_${++n}`;

describe('prune predicates', () => {
  it('cuts at 7 / 30 / 90 days and at expiry for agent codes', () => {
    const p = prunePredicates(NOW);
    expect(p.refreshToken).toEqual({
      OR: [{ expiresAt: { lt: ago(REFRESH_TOKEN_RETENTION_MS) } }, { revokedAt: { lt: ago(REFRESH_TOKEN_RETENTION_MS) } }],
    });
    expect(ago(REFRESH_TOKEN_RETENTION_MS).toISOString()).toBe('2026-09-28T12:00:00.000Z');
    expect(p.agentAuthCode).toEqual({ expiresAt: { lt: NOW } });
    expect(p.manualTimeOutbox).toEqual({ status: 'DONE', processedAt: { lt: ago(OUTBOX_DONE_RETENTION_MS) } });
    expect(p.manualTimeLarkMessage.updatedAt).toEqual({ lt: ago(LARK_MESSAGE_TERMINAL_RETENTION_MS) });
    expect(p.manualTimeLarkMessage.status.in.sort()).toEqual(['CANCELLED', 'DECIDED', 'STALE', 'SUPERSEDED']);
  });
});

describe('runPruneOnce', () => {
  it('deletes only settled rows past their window', async () => {
    const { userId } = await seedUser();
    const token = (data: { revokedAt?: Date | null; expiresAt: Date }) =>
      prisma.refreshToken.create({ data: { userId, tokenHash: uniq('h'), familyId: uniq('f'), ...data } });
    const liveToken = await token({ expiresAt: new Date(NOW.getTime() + 30 * DAY) });
    const recentlyRevoked = await token({ revokedAt: ago(2 * DAY), expiresAt: new Date(NOW.getTime() + 30 * DAY) });
    const oldRevoked = await token({ revokedAt: ago(8 * DAY), expiresAt: new Date(NOW.getTime() + 30 * DAY) });
    const longExpired = await token({ expiresAt: ago(8 * DAY) });

    const code = (expiresAt: Date) =>
      prisma.agentAuthCode.create({ data: { codeHash: uniq('c'), userId, challenge: 'x', expiresAt } });
    const expiredCode = await code(ago(60_000));
    const liveCode = await code(new Date(NOW.getTime() + 60_000));

    const req = await prisma.manualTimeRequest.create({
      data: {
        clientUuid: uniq('cu'),
        userId,
        requestedStart: ago(100 * DAY),
        requestedEnd: ago(100 * DAY - 3_600_000),
        reason: 'old',
        status: 'APPROVED',
      },
    });
    const msg = (status: 'DECIDED' | 'SENT' | 'SUPERSEDED') =>
      prisma.manualTimeLarkMessage.create({ data: { requestId: req.id, version: 1, recipientOpenId: 'ou_x', kind: 'APPROVAL', status } });
    const oldDecided = await msg('DECIDED');
    const oldSent = await msg('SENT');
    const recentSuperseded = await msg('SUPERSEDED');
    await prisma.$executeRaw`UPDATE "ManualTimeLarkMessage" SET "updatedAt" = ${ago(91 * DAY)} WHERE id IN (${oldDecided.id}, ${oldSent.id})`;
    await prisma.$executeRaw`UPDATE "ManualTimeLarkMessage" SET "updatedAt" = ${ago(10 * DAY)} WHERE id = ${recentSuperseded.id}`;

    const event = (status: 'DONE' | 'FAILED', processedAt: Date | null) =>
      prisma.manualTimeLarkOutboxEvent.create({ data: { requestId: req.id, kind: 'FINALIZE_CARDS', status, processedAt } });
    const oldDone = await event('DONE', ago(31 * DAY));
    const recentDone = await event('DONE', ago(5 * DAY));
    const oldFailed = await event('FAILED', null);

    const result = await runPruneOnce(NOW);
    expect(result).not.toBeNull();

    const exists = async (fn: () => Promise<unknown>) => Boolean(await fn());
    expect(await exists(() => prisma.refreshToken.findUnique({ where: { id: liveToken.id } }))).toBe(true);
    expect(await exists(() => prisma.refreshToken.findUnique({ where: { id: recentlyRevoked.id } }))).toBe(true);
    expect(await exists(() => prisma.refreshToken.findUnique({ where: { id: oldRevoked.id } }))).toBe(false);
    expect(await exists(() => prisma.refreshToken.findUnique({ where: { id: longExpired.id } }))).toBe(false);

    expect(await exists(() => prisma.agentAuthCode.findUnique({ where: { id: expiredCode.id } }))).toBe(false);
    expect(await exists(() => prisma.agentAuthCode.findUnique({ where: { id: liveCode.id } }))).toBe(true);

    expect(await exists(() => prisma.manualTimeLarkMessage.findUnique({ where: { id: oldDecided.id } }))).toBe(false);
    expect(await exists(() => prisma.manualTimeLarkMessage.findUnique({ where: { id: oldSent.id } }))).toBe(true);
    expect(await exists(() => prisma.manualTimeLarkMessage.findUnique({ where: { id: recentSuperseded.id } }))).toBe(true);

    expect(await exists(() => prisma.manualTimeLarkOutboxEvent.findUnique({ where: { id: oldDone.id } }))).toBe(false);
    expect(await exists(() => prisma.manualTimeLarkOutboxEvent.findUnique({ where: { id: recentDone.id } }))).toBe(true);
    expect(await exists(() => prisma.manualTimeLarkOutboxEvent.findUnique({ where: { id: oldFailed.id } }))).toBe(true);

    // The request itself is never pruned.
    expect(await exists(() => prisma.manualTimeRequest.findUnique({ where: { id: req.id } }))).toBe(true);
  });

  it('skips when another instance holds the prune lock', async () => {
    let inner: Awaited<ReturnType<typeof runPruneOnce>> | undefined;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(742019652::integer, 1::integer) IS NULL AS "locked"`;
      inner = await runPruneOnce(NOW);
    });
    expect(inner).toBeNull();
  });
});
