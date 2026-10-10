import { describe, expect, it } from 'vitest';
import { prisma } from '@grind/db';
import { backfillEvidenceLinks } from '../src/timeEntries/evidenceBackfill';
import { fakeUlid, seedUser } from './helpers';

const NOW = new Date('2026-10-09T14:00:00.000Z');
const MIN = 60_000;
const at = (minutesBeforeNow: number) => new Date(NOW.getTime() - minutesBeforeNow * MIN);
const asset = (fileId: string) => `https://timo.test/v1/screenshots/assets/${fileId}`;

async function entry(userId: string, id: string, startedAt: Date, endedAt: Date | null) {
  return prisma.timeEntry.create({
    data: { id, clientUuid: fakeUlid('client'), userId, source: 'AUTO', startedAt, endedAt },
  });
}

async function shot(userId: string, id: string, capturedAt: Date, over: Record<string, unknown> = {}) {
  return prisma.screenshot.create({
    data: { id, userId, capturedAt, uploadState: 'UPLOADED', s3Key: `file-${id}`, fullUrl: asset(`file-${id}`), ...over },
  });
}

async function minute(userId: string, bucketStart: Date, over: Record<string, unknown> = {}) {
  return prisma.activitySample.create({
    data: {
      id: fakeUlid('as'),
      userId,
      bucketStart,
      keystrokes: 1,
      clicks: 1,
      mouseDistancePx: 1,
      scrollEvents: 0,
      ...over,
    },
  });
}

/** The orphans of the 2026-10-09 incident, plus everything the repair must leave alone. */
async function seedOrphans() {
  const u = await seedUser();
  const other = await seedUser();
  await entry(u.userId, 'entry-closed', at(180), at(120));
  await entry(u.userId, 'entry-running', at(110), null);
  await entry(u.userId, 'entry-arrived', at(300), at(240));
  await entry(u.userId, 'entry-overlap-a', at(500), at(400));
  await entry(u.userId, 'entry-overlap-b', at(450), at(350));

  // Captured inside the closed entry, stored detached.
  await shot(u.userId, 'shot-window', at(150));
  // Claimed an entry that has since been created.
  await shot(u.userId, 'shot-claimed', at(270), { claimedTimeEntryId: 'entry-arrived' });
  // Refused by /complete: bytes in Drive, row stuck PENDING, inside the running entry.
  await shot(u.userId, 'shot-refused', at(100), { uploadState: 'PENDING', createdAt: at(95) });
  // Still uploading: too young to promote.
  await shot(u.userId, 'shot-in-flight', at(5), { uploadState: 'PENDING', createdAt: at(1) });
  // Outside every entry, and inside two at once.
  await shot(u.userId, 'shot-outside', at(200));
  await shot(u.userId, 'shot-ambiguous', at(420));
  // Somebody else's shot at the same time: never linked to this person's entry.
  await shot(other.userId, 'shot-other', at(150));

  await minute(u.userId, at(150));
  await minute(u.userId, at(271), { claimedTimeEntryId: 'entry-arrived' });
  await minute(u.userId, at(420));
  await minute(other.userId, at(150));
  return { u, other };
}

describe('backfillEvidenceLinks', () => {
  it('dry run counts what it would change and changes nothing', async () => {
    await seedOrphans();
    const report = await backfillEvidenceLinks({ apply: false, now: NOW });
    expect(report).toEqual({
      mode: 'dry-run',
      claimedScreenshots: 1,
      claimedSamples: 1,
      windowScreenshots: 3, // shot-window, shot-refused, shot-in-flight
      windowSamples: 1,
      ambiguousScreenshots: 1,
      ambiguousSamples: 1,
      promoteScreenshots: 1,
    });
    expect(await prisma.screenshot.count({ where: { timeEntryId: { not: null } } })).toBe(0);
    expect(await prisma.screenshot.count({ where: { uploadState: 'PENDING' } })).toBe(2);
  });

  it('applies the links and the promotion, leaving the rest alone', async () => {
    await seedOrphans();
    const report = await backfillEvidenceLinks({ apply: true, now: NOW });
    expect(report).toMatchObject({
      mode: 'applied',
      claimedScreenshots: 1,
      claimedSamples: 1,
      windowScreenshots: 3,
      windowSamples: 1,
      ambiguousScreenshots: 1,
      ambiguousSamples: 1,
      promoteScreenshots: 1,
    });

    const shots = Object.fromEntries(
      (await prisma.screenshot.findMany()).map((s) => [s.id, [s.timeEntryId, s.claimedTimeEntryId, s.uploadState]]),
    );
    expect(shots).toEqual({
      'shot-window': ['entry-closed', null, 'UPLOADED'],
      'shot-claimed': ['entry-arrived', null, 'UPLOADED'],
      'shot-refused': ['entry-running', null, 'UPLOADED'],
      'shot-in-flight': ['entry-running', null, 'PENDING'],
      'shot-outside': [null, null, 'UPLOADED'],
      'shot-ambiguous': [null, null, 'UPLOADED'],
      'shot-other': [null, null, 'UPLOADED'],
    });
    const linkedMinutes = await prisma.activitySample.findMany({
      where: { timeEntryId: { not: null } },
      orderBy: { bucketStart: 'asc' },
    });
    expect(linkedMinutes.map((m) => [m.timeEntryId, m.claimedTimeEntryId])).toEqual([
      ['entry-arrived', null],
      ['entry-closed', null],
    ]);

    // Idempotent: a second run finds nothing new.
    expect(await backfillEvidenceLinks({ apply: false, now: NOW })).toMatchObject({
      claimedScreenshots: 0,
      claimedSamples: 0,
      windowScreenshots: 0,
      windowSamples: 0,
      promoteScreenshots: 0,
    });
  });

  it('can be limited to one person and a start date', async () => {
    const { other } = await seedOrphans();
    expect(await backfillEvidenceLinks({ apply: false, now: NOW, userId: other.userId })).toMatchObject({
      claimedScreenshots: 0,
      windowScreenshots: 0,
      windowSamples: 0,
      promoteScreenshots: 0,
    });
    expect(await backfillEvidenceLinks({ apply: false, now: NOW, since: at(100) })).toMatchObject({
      claimedScreenshots: 0,
      windowScreenshots: 2, // shot-refused, shot-in-flight
      ambiguousScreenshots: 0,
      promoteScreenshots: 1,
    });
  });
});
