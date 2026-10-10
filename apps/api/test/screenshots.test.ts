import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { prisma } from '@grind/db';

// Drive on, the way production runs. Set before src/env.ts is parsed.
vi.hoisted(() => {
  process.env.PUBLIC_APP_URL = 'https://timo.test';
  process.env.GOOGLE_DRIVE_CLIENT_EMAIL = 'drive@timo.test';
  process.env.GOOGLE_DRIVE_PRIVATE_KEY = 'unused-in-tests';
  process.env.GOOGLE_DRIVE_FOLDER_ID = 'root-folder';
});

const drive = vi.hoisted(() => ({
  /** fileId -> Drive file name, as the upload endpoint named it. */
  files: new Map<string, string>(),
  uploads: [] as Array<{ filename: string; capturedAt?: Date; tz?: string }>,
  trashed: [] as string[],
  next: 0,
}));

vi.mock('../src/lib/googleDrive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/googleDrive')>();
  return {
    ...actual,
    isGoogleDriveConfigured: () => true,
    uploadScreenshotToDrive: vi.fn(async (input: { filename: string; capturedAt?: Date; tz?: string }) => {
      drive.next += 1;
      const fileId = `drive-file-${drive.next}`;
      drive.files.set(fileId, input.filename);
      drive.uploads.push({ filename: input.filename, capturedAt: input.capturedAt, tz: input.tz });
      return { fileId };
    }),
    getDriveFileName: vi.fn(async (fileId: string) => drive.files.get(fileId) ?? null),
    downloadScreenshotFromDrive: vi.fn(async (fileId: string) => Buffer.from(`bytes-of-${fileId}`)),
    trashScreenshotInDrive: vi.fn(async (fileId: string) => {
      drive.trashed.push(fileId);
      return 'trashed' as const;
    }),
  };
});

const { buildApp } = await import('../src/app');
const { capturedAtFromScreenshotId } = await import('../src/routes/screenshots');
const { seedUser, createManagedTeam } = await import('./helpers');
const { linkClaimedEvidence, linkClaimsIfEntriesArrived } = await import('../src/timeEntries/claimedEvidence');

let app: Express;
beforeAll(() => {
  app = buildApp();
});

beforeEach(() => {
  drive.files.clear();
  drive.uploads.length = 0;
  drive.trashed.length = 0;
  drive.next = 0;
});

// ULIDs whose time component is 2026-08-03T10:00:00.000Z and a moment later.
const SHOT_AUG = '01KZ3H1R80ABCDEFGHJKMNPQRS';
const SHOT_AUG_2 = '01KZ3H1R80ABCDEFGHJKMNPQRT';

async function sign(token: string, id: string): Promise<string> {
  const res = await request(app).post('/v1/screenshots/sign').set('Authorization', `Bearer ${token}`).send({ id });
  expect(res.status).toBe(200);
  return res.body.uploadUrl as string;
}

async function directUpload(uploadUrl: string, bytes = 'webp-bytes') {
  const url = new URL(uploadUrl);
  return request(app)
    .post(`${url.pathname}${url.search}`)
    .attach('file', Buffer.from(bytes), { filename: 'shot.webp', contentType: 'image/webp' });
}

function complete(token: string, body: Record<string, unknown>) {
  return request(app)
    .post('/v1/screenshots/complete')
    .set('Authorization', `Bearer ${token}`)
    .send({ capturedAt: '2026-08-03T10:00:00.000Z', uploadState: 'UPLOADED', ...body });
}

describe('screenshot ids carry their capture time', () => {
  it('reads the ULID timestamp', () => {
    expect(capturedAtFromScreenshotId(SHOT_AUG, Date.UTC(2026, 9, 5))?.toISOString()).toBe('2026-08-03T10:00:00.000Z');
  });

  it('refuses non-ULIDs and implausible times', () => {
    expect(capturedAtFromScreenshotId('not-a-ulid')).toBeNull();
    expect(capturedAtFromScreenshotId('00000000000000000000000000')).toBeNull();
    expect(capturedAtFromScreenshotId('7ZZZZZZZZZZZZZZZZZZZZZZZZZ')).toBeNull();
  });
});

describe('POST /v1/screenshots/direct-upload', () => {
  it('files a backlog shot under the month it was taken, and records the file server-side', async () => {
    const u = await seedUser();
    const res = await directUpload(await sign(u.accessToken, SHOT_AUG));

    expect(res.status).toBe(200);
    expect(res.body.public_id).toBe('drive-file-1');
    expect(drive.uploads[0]?.capturedAt?.toISOString()).toBe('2026-08-03T10:00:00.000Z');
    expect(drive.uploads[0]?.filename).toBe(`${u.userId}-${SHOT_AUG}.webp`);

    const row = await prisma.screenshot.findUniqueOrThrow({ where: { id: SHOT_AUG } });
    expect(row).toMatchObject({ userId: u.userId, s3Key: 'drive-file-1', uploadState: 'PENDING' });
  });

  it('is idempotent: a retried upload of a stored shot returns the same file without a second copy', async () => {
    const u = await seedUser();
    const first = await directUpload(await sign(u.accessToken, SHOT_AUG));
    const again = await directUpload(await sign(u.accessToken, SHOT_AUG));

    expect(again.status).toBe(200);
    expect(again.body.public_id).toBe(first.body.public_id);
    expect(drive.uploads).toHaveLength(1);
  });
});

describe('POST /v1/screenshots/complete', () => {
  it('keeps a shot whose timer entry the server does not have, remembering the entry', async () => {
    const u = await seedUser();
    const up = await directUpload(await sign(u.accessToken, SHOT_AUG));

    const res = await complete(u.accessToken, {
      id: SHOT_AUG,
      timeEntryId: 'entry-still-being-created',
      s3Key: up.body.public_id,
      fullUrl: up.body.secure_url,
    });

    expect(res.status).toBe(201);
    const row = await prisma.screenshot.findUniqueOrThrow({ where: { id: SHOT_AUG } });
    expect(row).toMatchObject({
      timeEntryId: null,
      claimedTimeEntryId: 'entry-still-being-created',
      uploadState: 'UPLOADED',
      s3Key: 'drive-file-1',
    });
  });

  it('links shots that arrived before their entry once the agent creates it', async () => {
    // The 2026-10-09 incident: the entry create sat in a stuck sync queue while
    // every shot after it named that entry.
    const u = await seedUser();
    const entryId = '01KZ3H1R80ENTRYSTUCKQUEUE1';
    await directUpload(await sign(u.accessToken, SHOT_AUG));
    await directUpload(await sign(u.accessToken, SHOT_AUG_2));
    expect((await complete(u.accessToken, { id: SHOT_AUG, timeEntryId: entryId })).status).toBe(201);
    // An old agent that already gave up reports the shot FAILED: still kept.
    expect((await complete(u.accessToken, { id: SHOT_AUG_2, timeEntryId: entryId, uploadState: 'FAILED' })).status)
      .toBe(201);

    const startedAt = '2026-08-03T09:55:00.000Z';
    const created = await request(app)
      .post('/v1/time-entries')
      .set('Authorization', `Bearer ${u.accessToken}`)
      .send({
        id: entryId,
        clientUuid: 'client-stuck-queue',
        source: 'AUTO',
        startedAt,
        endedAt: null,
        segments: [{ id: 'segment-stuck-queue', kind: 'WORK', startedAt, endedAt: null }],
      });
    expect(created.status).toBe(201);

    const rows = await prisma.screenshot.findMany({ where: { userId: u.userId }, orderBy: { id: 'asc' } });
    expect(rows.map((row) => [row.timeEntryId, row.claimedTimeEntryId, row.uploadState])).toEqual([
      [entryId, null, 'UPLOADED'],
      [entryId, null, 'UPLOADED'],
    ]);
  });

  it('refuses a shot naming another user\'s entry, and never links another user\'s claim', async () => {
    const owner = await seedUser();
    const other = await seedUser();
    const foreign = await prisma.timeEntry.create({
      data: { id: 'entry-foreign', clientUuid: 'client-foreign', userId: owner.userId, source: 'AUTO', startedAt: new Date() },
    });
    await directUpload(await sign(other.accessToken, SHOT_AUG));
    const res = await complete(other.accessToken, { id: SHOT_AUG, timeEntryId: foreign.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('time_entry_out_of_scope');

    // `other` claims an id that `owner` later creates: it stays a claim.
    await directUpload(await sign(other.accessToken, SHOT_AUG_2));
    await complete(other.accessToken, { id: SHOT_AUG_2, timeEntryId: 'entry-later' });
    await linkClaimedEvidence(await prisma.timeEntry.create({
      data: { id: 'entry-later', clientUuid: 'client-later', userId: owner.userId, source: 'AUTO', startedAt: new Date() },
    }));
    const row = await prisma.screenshot.findUniqueOrThrow({ where: { id: SHOT_AUG_2 } });
    expect([row.timeEntryId, row.claimedTimeEntryId]).toEqual([null, 'entry-later']);
  });

  it('links a claim whose entry was created while the shot was being stored', async () => {
    const u = await seedUser();
    await directUpload(await sign(u.accessToken, SHOT_AUG));
    await complete(u.accessToken, { id: SHOT_AUG, timeEntryId: 'entry-raced' });
    // The entry commits without linking (its link ran before the claim landed).
    await prisma.timeEntry.create({
      data: { id: 'entry-raced', clientUuid: 'client-raced', userId: u.userId, source: 'AUTO', startedAt: new Date() },
    });
    await linkClaimsIfEntriesArrived(u.userId, ['entry-raced']);
    const row = await prisma.screenshot.findUniqueOrThrow({ where: { id: SHOT_AUG } });
    expect([row.timeEntryId, row.claimedTimeEntryId]).toEqual(['entry-raced', null]);
  });

  it('attaches the shot to an entry the user owns', async () => {
    const u = await seedUser();
    const entry = await prisma.timeEntry.create({
      data: { id: 'entry-own', clientUuid: 'client-own', userId: u.userId, source: 'AUTO', startedAt: new Date() },
    });
    await directUpload(await sign(u.accessToken, SHOT_AUG));
    const res = await complete(u.accessToken, { id: SHOT_AUG, timeEntryId: entry.id });
    expect(res.status).toBe(201);
    const row = await prisma.screenshot.findUniqueOrThrow({ where: { id: SHOT_AUG } });
    expect(row.timeEntryId).toBe(entry.id);
  });

  it('ignores a client file id and URL when the server recorded the upload itself', async () => {
    const u = await seedUser();
    await directUpload(await sign(u.accessToken, SHOT_AUG));

    const res = await complete(u.accessToken, {
      id: SHOT_AUG,
      s3Key: 'someone-elses-file',
      fullUrl: 'https://169.254.169.254/latest/meta-data',
      thumbUrl: 'https://evil.test/thumb.webp',
    });

    expect(res.status).toBe(201);
    const row = await prisma.screenshot.findUniqueOrThrow({ where: { id: SHOT_AUG } });
    expect(row.s3Key).toBe('drive-file-1');
    expect(row.fullUrl).toBe('https://timo.test/v1/screenshots/assets/drive-file-1');
    expect(row.thumbUrl).toBeNull();
  });

  it('refuses an UPLOADED claim pointing at a file that is not this shot', async () => {
    const victim = await seedUser();
    const attacker = await seedUser();
    const up = await directUpload(await sign(victim.accessToken, SHOT_AUG));

    const res = await complete(attacker.accessToken, {
      id: SHOT_AUG_2,
      s3Key: up.body.public_id,
      fullUrl: 'https://169.254.169.254/latest/meta-data',
    });

    expect(res.status).toBe(422);
    expect(await prisma.screenshot.findUnique({ where: { id: SHOT_AUG_2 } })).toBeNull();
  });

  it('accepts a client file id Drive names as this user\'s upload of this shot', async () => {
    const u = await seedUser();
    drive.files.set('raced-deploy-file', `${u.userId}-${SHOT_AUG}.webp`);

    const res = await complete(u.accessToken, { id: SHOT_AUG, s3Key: 'raced-deploy-file' });

    expect(res.status).toBe(201);
    const row = await prisma.screenshot.findUniqueOrThrow({ where: { id: SHOT_AUG } });
    expect(row).toMatchObject({ s3Key: 'raced-deploy-file', uploadState: 'UPLOADED' });
  });

  it('a FAILED notice does not demote a shot whose bytes the server holds', async () => {
    const u = await seedUser();
    await directUpload(await sign(u.accessToken, SHOT_AUG));
    const res = await complete(u.accessToken, { id: SHOT_AUG, uploadState: 'FAILED' });
    expect(res.status).toBe(201);
    expect(res.body.uploadState).toBe('UPLOADED');
  });
});

describe('serving screenshot images', () => {
  async function seedForeignRow(input: { ownerId: string; id: string; s3Key: string | null; fullUrl: string | null }) {
    return prisma.screenshot.create({
      data: {
        id: input.id,
        userId: input.ownerId,
        capturedAt: new Date('2026-08-03T10:00:00.000Z'),
        s3Key: input.s3Key,
        fullUrl: input.fullUrl,
        uploadState: 'UPLOADED',
      },
    });
  }

  it('serves the recorded Drive file to its owner', async () => {
    const u = await seedUser();
    await directUpload(await sign(u.accessToken, SHOT_AUG));
    await complete(u.accessToken, { id: SHOT_AUG });

    const res = await request(app)
      .get(`/v1/screenshots/${SHOT_AUG}/image?variant=full`)
      .set('Authorization', `Bearer ${u.accessToken}`);
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body as Buffer).toString()).toBe('bytes-of-drive-file-1');
  });

  it('will not serve another user\'s Drive file through a row that claims it', async () => {
    const victim = await seedUser();
    const attacker = await seedUser();
    const up = await directUpload(await sign(victim.accessToken, SHOT_AUG));
    // A row written before the server recorded file ids itself.
    await seedForeignRow({ ownerId: attacker.userId, id: SHOT_AUG_2, s3Key: up.body.public_id, fullUrl: null });

    const image = await request(app)
      .get(`/v1/screenshots/${SHOT_AUG_2}/image?variant=full`)
      .set('Authorization', `Bearer ${attacker.accessToken}`);
    expect(image.status).toBe(404);

    const asset = await request(app)
      .get(`/v1/screenshots/assets/${up.body.public_id}`)
      .set('Authorization', `Bearer ${attacker.accessToken}`);
    expect(asset.status).toBe(404);
  });

  it('never fetches an arbitrary URL stored on a row', async () => {
    const u = await seedUser();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await seedForeignRow({ ownerId: u.userId, id: SHOT_AUG, s3Key: null, fullUrl: 'https://169.254.169.254/latest' });

    const res = await request(app)
      .get(`/v1/screenshots/${SHOT_AUG}/image?variant=full`)
      .set('Authorization', `Bearer ${u.accessToken}`);

    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('serves an asset to a manager who can see the uploader', async () => {
    const manager = await seedUser({ role: 'ADMIN' });
    const member = await prisma.user.create({
      data: {
        workspaceId: manager.workspaceId,
        email: `member-${Date.now()}@test.local`,
        name: 'Member',
        role: 'MEMBER',
        provisioningStatus: 'ACTIVE',
      },
    });
    await createManagedTeam({ workspaceId: manager.workspaceId, name: 'Team', managerId: manager.userId });
    drive.files.set('member-file', `${member.id}-${SHOT_AUG}.webp`);
    await seedForeignRow({ ownerId: member.id, id: SHOT_AUG, s3Key: 'member-file', fullUrl: null });

    const res = await request(app)
      .get('/v1/screenshots/assets/member-file')
      .set('Authorization', `Bearer ${manager.accessToken}`);
    expect(res.status).toBe(200);
  });
});
