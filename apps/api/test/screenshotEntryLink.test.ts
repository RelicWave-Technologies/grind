import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { fakeUlid, seedUser } from './helpers';

const app = buildApp();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

function completeBody(timeEntryId: string | null) {
  return {
    id: fakeUlid('shot'),
    timeEntryId,
    capturedAt: new Date().toISOString(),
    s3Key: 'drive-file-id',
    uploadState: 'UPLOADED',
  };
}

describe('screenshot entry link', () => {
  it('keeps a shot whose entry has not reached the server yet, unlinked', async () => {
    const user = await seedUser();
    const body = completeBody(fakeUlid('entry-not-synced-yet'));

    const res = await request(app).post('/v1/screenshots/complete').set(bearer(user.accessToken)).send(body);

    expect(res.status).toBe(201);
    const row = await prisma.screenshot.findUniqueOrThrow({ where: { id: body.id } });
    expect(row.userId).toBe(user.userId);
    expect(row.timeEntryId).toBeNull();
  });

  it('still refuses to link a shot to somebody else\'s entry', async () => {
    const owner = await seedUser();
    const other = await seedUser();
    const entryId = fakeUlid('foreign-entry');
    await prisma.timeEntry.create({
      data: {
        id: entryId,
        clientUuid: fakeUlid('foreign-client'),
        userId: owner.userId,
        source: 'AUTO',
        startedAt: new Date(Date.now() - 60_000),
      },
    });

    const res = await request(app)
      .post('/v1/screenshots/complete')
      .set(bearer(other.accessToken))
      .send(completeBody(entryId));

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'time_entry_out_of_scope' });
  });
});
