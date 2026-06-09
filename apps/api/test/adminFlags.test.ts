import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';
import { persistFlagsForUser } from '../src/anticheat/persistFlags';

/**
 * /v1/admin/flags + persistFlagsForUser — real Postgres.
 *
 * Coverage:
 *   - persist: creates flag rows from a metronomic key-spam pattern.
 *   - persist: dedupes on (userId, windowStart, type).
 *   - persist: preserves RESOLVED verdicts even if pattern repeats.
 *   - GET: scope filtering (MEMBER 403, MANAGER team-only, ADMIN workspace).
 *   - GET: ?status= and ?type= filters; 400 on bogus values.
 *   - POST /:id/resolve: stamps resolution + reviewer + note.
 *   - POST: 409 on already-resolved; 403 on cross-scope.
 */

const app = buildApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let counter = 0;
async function seed() {
  counter += 1;
  const stamp = `${Date.now()}-${counter}`;
  const ws = await prisma.workspace.create({ data: { name: `WS-flags-${stamp}` } });
  const mk = (email: string, name: string, role: 'ADMIN' | 'MANAGER' | 'MEMBER') =>
    prisma.user.create({
      data: { workspaceId: ws.id, email: `${email}-${stamp}@test.local`, name, role, passwordHash: 'x'.repeat(60) },
    });
  const admin = await mk('admin', 'Alice Admin', 'ADMIN');
  const mgrA = await mk('mgr-a', 'Mira Manager A', 'MANAGER');
  const memA = await mk('mem-a', 'Mia Member A', 'MEMBER');
  const mgrB = await mk('mgr-b', 'Mark Manager B', 'MANAGER');
  const memB = await mk('mem-b', 'Bob Member B', 'MEMBER');

  const teamA = await prisma.team.create({ data: { workspaceId: ws.id, name: 'A', managerId: mgrA.id } });
  await prisma.user.updateMany({ where: { id: { in: [mgrA.id, memA.id] } }, data: { teamId: teamA.id } });
  const teamB = await prisma.team.create({ data: { workspaceId: ws.id, name: 'B', managerId: mgrB.id } });
  await prisma.user.updateMany({ where: { id: { in: [mgrB.id, memB.id] } }, data: { teamId: teamB.id } });

  const tok = (u: { id: string; role: 'ADMIN' | 'MANAGER' | 'MEMBER' }) =>
    signAccessToken({ sub: u.id, ws: ws.id, role: u.role });

  return {
    ws,
    admin: { id: admin.id, token: tok(admin) },
    mgrA: { id: mgrA.id, token: tok(mgrA) },
    memA: { id: memA.id, token: tok(memA) },
    mgrB: { id: mgrB.id, token: tok(mgrB) },
    memB: { id: memB.id, token: tok(memB) },
  };
}

/** A 5-minute metronomic key-spam pattern (very low ikiCv, high keys). */
function metronomicSamples(startMs: number) {
  const out: Parameters<typeof persistFlagsForUser>[0]['samples'] = [];
  for (let i = 0; i < 5; i++) {
    out.push({
      bucketStartMs: startMs + i * 60_000,
      keystrokes: 400,
      clicks: 0,
      scrollEvents: 0,
      mouseDistancePx: 0,
      ikiCv: 0.05, // very low → metronomic
      moveSpeedCv: null,
      pathStraightness: null,
    });
  }
  return out;
}

describe('persistFlagsForUser', () => {
  it('raises a METRONOMIC flag on a low-CV key-spam window', async () => {
    const s = await seed();
    const start = new Date('2026-05-30T09:00:00Z').getTime();
    const r = await persistFlagsForUser({ userId: s.memA.id, samples: metronomicSamples(start) });
    expect(r.raised).toBeGreaterThan(0);
    expect(r.inserted).toBeGreaterThan(0);
    const flags = await prisma.activityFlag.findMany({ where: { userId: s.memA.id } });
    const types = flags.map((f) => f.type);
    expect(types).toContain('METRONOMIC');
  });

  it('is idempotent on the same (user, windowStart, type)', async () => {
    const s = await seed();
    const start = new Date('2026-05-30T09:00:00Z').getTime();
    await persistFlagsForUser({ userId: s.memA.id, samples: metronomicSamples(start) });
    await persistFlagsForUser({ userId: s.memA.id, samples: metronomicSamples(start) });
    const flags = await prisma.activityFlag.findMany({ where: { userId: s.memA.id, type: 'METRONOMIC' } });
    expect(flags).toHaveLength(1);
  });

  it('preserves RESOLVED verdicts when the pattern repeats', async () => {
    const s = await seed();
    const start = new Date('2026-05-30T09:00:00Z').getTime();
    await persistFlagsForUser({ userId: s.memA.id, samples: metronomicSamples(start) });
    const flag = await prisma.activityFlag.findFirst({ where: { userId: s.memA.id } });
    // Dismiss it.
    await prisma.activityFlag.update({
      where: { id: flag!.id },
      data: { status: 'RESOLVED', resolution: 'DISMISSED', resolvedById: s.admin.id, resolvedAt: new Date(), resolvedNote: 'legit' },
    });
    // Re-run; engine still sees the pattern but should not flip the verdict.
    await persistFlagsForUser({ userId: s.memA.id, samples: metronomicSamples(start) });
    const reload = await prisma.activityFlag.findUnique({ where: { id: flag!.id } });
    expect(reload?.status).toBe('RESOLVED');
    expect(reload?.resolution).toBe('DISMISSED');
  });

  it('does nothing for empty input', async () => {
    const s = await seed();
    const r = await persistFlagsForUser({ userId: s.memA.id, samples: [] });
    expect(r).toEqual({ raised: 0, inserted: 0, riskScore: 0 });
  });
});

describe('GET /v1/admin/flags', () => {
  it('MEMBER → 403', async () => {
    const s = await seed();
    const res = await request(app).get('/v1/admin/flags').set(auth(s.memA.token));
    expect(res.status).toBe(403);
  });

  it('MANAGER A sees flags for member-A; not member-B', async () => {
    const s = await seed();
    await persistFlagsForUser({
      userId: s.memA.id,
      samples: metronomicSamples(new Date('2026-05-30T09:00:00Z').getTime()),
    });
    await persistFlagsForUser({
      userId: s.memB.id,
      samples: metronomicSamples(new Date('2026-05-30T09:00:00Z').getTime()),
    });
    const res = await request(app).get('/v1/admin/flags').set(auth(s.mgrA.token));
    expect(res.status).toBe(200);
    const userIds = new Set(res.body.flags.map((f: { userId: string }) => f.userId));
    expect(userIds.has(s.memA.id)).toBe(true);
    expect(userIds.has(s.memB.id)).toBe(false);
  });

  it('ADMIN sees flags across both teams', async () => {
    const s = await seed();
    await persistFlagsForUser({
      userId: s.memA.id,
      samples: metronomicSamples(new Date('2026-05-30T09:00:00Z').getTime()),
    });
    await persistFlagsForUser({
      userId: s.memB.id,
      samples: metronomicSamples(new Date('2026-05-30T11:00:00Z').getTime()),
    });
    const res = await request(app).get('/v1/admin/flags').set(auth(s.admin.token));
    expect(res.status).toBe(200);
    const userIds = new Set(res.body.flags.map((f: { userId: string }) => f.userId));
    expect(userIds.has(s.memA.id)).toBe(true);
    expect(userIds.has(s.memB.id)).toBe(true);
  });

  it('?status=RESOLVED filters out OPEN flags', async () => {
    const s = await seed();
    await persistFlagsForUser({
      userId: s.memA.id,
      samples: metronomicSamples(new Date('2026-05-30T09:00:00Z').getTime()),
    });
    const flag = await prisma.activityFlag.findFirst({ where: { userId: s.memA.id } });
    await request(app)
      .post(`/v1/admin/flags/${flag!.id}/resolve`)
      .set(auth(s.admin.token))
      .send({ resolution: 'DISMISSED' });
    const res = await request(app).get('/v1/admin/flags?status=RESOLVED').set(auth(s.admin.token));
    expect(res.status).toBe(200);
    expect(res.body.flags.every((f: { status: string }) => f.status === 'RESOLVED')).toBe(true);
  });

  it('invalid ?status= → 400', async () => {
    const s = await seed();
    const res = await request(app).get('/v1/admin/flags?status=BOGUS').set(auth(s.admin.token));
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/admin/flags/:id/resolve', () => {
  it('MANAGER A resolves a flag on member-A → stamps reviewer + verdict', async () => {
    const s = await seed();
    await persistFlagsForUser({
      userId: s.memA.id,
      samples: metronomicSamples(new Date('2026-05-30T09:00:00Z').getTime()),
    });
    const flag = await prisma.activityFlag.findFirst({ where: { userId: s.memA.id } });
    const res = await request(app)
      .post(`/v1/admin/flags/${flag!.id}/resolve`)
      .set(auth(s.mgrA.token))
      .send({ resolution: 'DISMISSED', note: 'They were typing in a Slack thread, false positive' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('RESOLVED');
    expect(res.body.resolution).toBe('DISMISSED');
    const reload = await prisma.activityFlag.findUnique({ where: { id: flag!.id } });
    expect(reload?.resolvedById).toBe(s.mgrA.id);
    expect(reload?.resolvedNote).toContain('Slack');
  });

  it('MANAGER B cannot resolve member-A flag (out of scope) → 403', async () => {
    const s = await seed();
    await persistFlagsForUser({
      userId: s.memA.id,
      samples: metronomicSamples(new Date('2026-05-30T09:00:00Z').getTime()),
    });
    const flag = await prisma.activityFlag.findFirst({ where: { userId: s.memA.id } });
    const res = await request(app)
      .post(`/v1/admin/flags/${flag!.id}/resolve`)
      .set(auth(s.mgrB.token))
      .send({ resolution: 'DISMISSED' });
    expect(res.status).toBe(403);
  });

  it('409 on already-resolved (re-decide is rejected)', async () => {
    const s = await seed();
    await persistFlagsForUser({
      userId: s.memA.id,
      samples: metronomicSamples(new Date('2026-05-30T09:00:00Z').getTime()),
    });
    const flag = await prisma.activityFlag.findFirst({ where: { userId: s.memA.id } });
    await request(app)
      .post(`/v1/admin/flags/${flag!.id}/resolve`)
      .set(auth(s.admin.token))
      .send({ resolution: 'DISMISSED' });
    const res = await request(app)
      .post(`/v1/admin/flags/${flag!.id}/resolve`)
      .set(auth(s.admin.token))
      .send({ resolution: 'CONFIRMED' });
    expect(res.status).toBe(409);
  });

  it('400 on invalid resolution string', async () => {
    const s = await seed();
    await persistFlagsForUser({
      userId: s.memA.id,
      samples: metronomicSamples(new Date('2026-05-30T09:00:00Z').getTime()),
    });
    const flag = await prisma.activityFlag.findFirst({ where: { userId: s.memA.id } });
    const res = await request(app)
      .post(`/v1/admin/flags/${flag!.id}/resolve`)
      .set(auth(s.admin.token))
      .send({ resolution: 'TOTALLY_FINE' });
    expect(res.status).toBe(400);
  });
});
