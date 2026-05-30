import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { seedUser } from './helpers';

/**
 * Integration tests for PATCH /v1/time-entries/:id — re-attribute task,
 * update notes. Cannot change start/end/segments. Real Postgres, no mocks.
 */

const app = buildApp();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function createEntry(userId: string, opts: { larkTaskGuid?: string | null; notes?: string | null } = {}) {
  const id = `te_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const startedAt = new Date('2026-05-20T09:00:00Z');
  const endedAt = new Date('2026-05-20T10:00:00Z');
  return prisma.timeEntry.create({
    data: {
      id,
      clientUuid: `cu_${id}`,
      userId,
      source: 'AUTO',
      larkTaskGuid: opts.larkTaskGuid ?? null,
      notes: opts.notes ?? null,
      startedAt,
      endedAt,
      segments: { create: [{ id: `s_${id}`, kind: 'WORK', startedAt, endedAt }] },
    },
  });
}

describe('PATCH /v1/time-entries/:id — happy path', () => {
  it('updates larkTaskGuid + notes and returns the serialized entry', async () => {
    const u = await seedUser();
    const entry = await createEntry(u.userId, { larkTaskGuid: 'old_task' });
    const res = await request(app)
      .patch(`/v1/time-entries/${entry.id}`)
      .set(bearer(u.accessToken))
      .send({ larkTaskGuid: 'new_task', notes: 'finished onboarding' });
    expect(res.status).toBe(200);
    expect(res.body.larkTaskGuid).toBe('new_task');
    expect(res.body.notes).toBe('finished onboarding');

    const fresh = await prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(fresh.larkTaskGuid).toBe('new_task');
    expect(fresh.notes).toBe('finished onboarding');
  });

  it('accepts null to clear larkTaskGuid (re-untag a session)', async () => {
    const u = await seedUser();
    const entry = await createEntry(u.userId, { larkTaskGuid: 'task_X' });
    const res = await request(app)
      .patch(`/v1/time-entries/${entry.id}`)
      .set(bearer(u.accessToken))
      .send({ larkTaskGuid: null });
    expect(res.status).toBe(200);
    expect(res.body.larkTaskGuid).toBeNull();
  });

  it('accepts partial updates — sending only notes leaves larkTaskGuid alone', async () => {
    const u = await seedUser();
    const entry = await createEntry(u.userId, { larkTaskGuid: 'keep_me' });
    const res = await request(app)
      .patch(`/v1/time-entries/${entry.id}`)
      .set(bearer(u.accessToken))
      .send({ notes: 'just a note' });
    expect(res.status).toBe(200);
    expect(res.body.larkTaskGuid).toBe('keep_me');
    expect(res.body.notes).toBe('just a note');
  });
});

describe('PATCH /v1/time-entries/:id — auth + ownership', () => {
  it('401 without auth', async () => {
    const res = await request(app).patch('/v1/time-entries/te_anything').send({ notes: 'x' });
    expect(res.status).toBe(401);
  });

  it("403 when patching another user's entry", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const entry = await createEntry(owner.userId);
    const res = await request(app)
      .patch(`/v1/time-entries/${entry.id}`)
      .set(bearer(stranger.accessToken))
      .send({ notes: 'malicious' });
    expect(res.status).toBe(403);
  });

  it('404 on a missing entry', async () => {
    const u = await seedUser();
    const res = await request(app)
      .patch('/v1/time-entries/te_does_not_exist')
      .set(bearer(u.accessToken))
      .send({ notes: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /v1/time-entries/:id — validation', () => {
  it('400 when no fields are set (must change something)', async () => {
    const u = await seedUser();
    const entry = await createEntry(u.userId);
    const res = await request(app)
      .patch(`/v1/time-entries/${entry.id}`)
      .set(bearer(u.accessToken))
      .send({});
    expect(res.status).toBe(400);
  });

  it('400 when notes exceeds 500 chars', async () => {
    const u = await seedUser();
    const entry = await createEntry(u.userId);
    const res = await request(app)
      .patch(`/v1/time-entries/${entry.id}`)
      .set(bearer(u.accessToken))
      .send({ notes: 'x'.repeat(501) });
    expect(res.status).toBe(400);
  });

  it('400 when client tries to change start/end via an unknown field', async () => {
    const u = await seedUser();
    const entry = await createEntry(u.userId);
    // The schema doesn't include startedAt — but PATCH should not silently
    // accept it. We require at least one of the known fields; sending only
    // startedAt should be 400.
    const res = await request(app)
      .patch(`/v1/time-entries/${entry.id}`)
      .set(bearer(u.accessToken))
      .send({ startedAt: '2027-01-01T00:00:00.000Z' });
    expect(res.status).toBe(400);
    // Doubly ensure the entry's startedAt was unchanged.
    const fresh = await prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(fresh.startedAt.getTime()).toBe(entry.startedAt.getTime());
  });
});
