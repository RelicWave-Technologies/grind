import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { ulid } from 'ulid';
import { buildApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';
import { NINE_TO_SIX, EMPTY_SCHEDULE } from '@grind/types';

/**
 * /v1/admin/shifts CRUD + PATCH user.shiftId + GET /v1/auth/me/shift
 * + TimeEntry.shiftIdAtStart snapshot. Real Postgres, no mocks.
 */

const app = buildApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let counter = 0;
async function seed() {
  counter += 1;
  const stamp = `${Date.now()}-${counter}`;
  const ws = await prisma.workspace.create({ data: { name: `WS-shifts-${stamp}` } });
  const wsOther = await prisma.workspace.create({ data: { name: `WS-other-${stamp}` } });
  const mk = (workspaceId: string, tag: string, role: 'ADMIN' | 'MANAGER' | 'MEMBER') =>
    prisma.user.create({
      data: {
        workspaceId,
        email: `${tag}-${stamp}@test.local`,
        name: `${tag} user`,
        role,
        passwordHash: 'x'.repeat(60),
      },
    });
  const admin = await mk(ws.id, 'admin', 'ADMIN');
  const mgr = await mk(ws.id, 'mgr', 'MANAGER');
  const mem = await mk(ws.id, 'mem', 'MEMBER');
  const bystander = await mk(wsOther.id, 'by', 'MEMBER');

  const tok = (u: { id: string; role: 'ADMIN' | 'MANAGER' | 'MEMBER' }, wsId = ws.id) =>
    signAccessToken({ sub: u.id, ws: wsId, role: u.role });

  return {
    ws,
    wsOther,
    admin: { id: admin.id, token: tok(admin) },
    mgr: { id: mgr.id, token: tok(mgr) },
    mem: { id: mem.id, token: tok(mem) },
    bystander: { id: bystander.id, token: tok(bystander, wsOther.id) },
  };
}

describe('GET /v1/admin/shifts', () => {
  it('MEMBER → 403', async () => {
    const s = await seed();
    const res = await request(app).get('/v1/admin/shifts').set(auth(s.mem.token));
    expect(res.status).toBe(403);
  });

  it('MANAGER + ADMIN see workspace shifts, scoped to own workspace', async () => {
    const s = await seed();
    await prisma.shift.create({
      data: { workspaceId: s.ws.id, name: 'Day', schedule: NINE_TO_SIX, bufferMin: 30 },
    });
    await prisma.shift.create({
      data: { workspaceId: s.wsOther.id, name: 'Other-WS Day', schedule: NINE_TO_SIX, bufferMin: 30 },
    });
    const mgrRes = await request(app).get('/v1/admin/shifts').set(auth(s.mgr.token));
    expect(mgrRes.status).toBe(200);
    expect(mgrRes.body.shifts.map((x: { name: string }) => x.name)).toEqual(['Day']);
  });
});

describe('POST /v1/admin/shifts', () => {
  it('MEMBER + MANAGER 403; ADMIN can create', async () => {
    const s = await seed();
    for (const role of [s.mem, s.mgr]) {
      const r = await request(app)
        .post('/v1/admin/shifts')
        .set(auth(role.token))
        .send({ name: 'Late', schedule: NINE_TO_SIX, bufferMin: 30 });
      expect(r.status).toBe(403);
    }
    const ok = await request(app)
      .post('/v1/admin/shifts')
      .set(auth(s.admin.token))
      .send({ name: 'Late', schedule: NINE_TO_SIX, bufferMin: 30 });
    expect(ok.status).toBe(201);
    expect(ok.body.name).toBe('Late');
    expect(ok.body.memberCount).toBe(0);
  });

  it('bufferMin defaults to 30 when omitted', async () => {
    const s = await seed();
    const r = await request(app)
      .post('/v1/admin/shifts')
      .set(auth(s.admin.token))
      .send({ name: 'Default-buffer', schedule: NINE_TO_SIX });
    expect(r.status).toBe(201);
    expect(r.body.bufferMin).toBe(30);
  });

  it('400 on malformed schedule (missing weekday key)', async () => {
    const s = await seed();
    const r = await request(app)
      .post('/v1/admin/shifts')
      .set(auth(s.admin.token))
      .send({ name: 'Broken', schedule: { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null /* sun missing */ } });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_body');
  });

  it('400 when end <= start for a day', async () => {
    const s = await seed();
    const bad = { ...NINE_TO_SIX, mon: { start: '18:00', end: '09:00' } };
    const r = await request(app)
      .post('/v1/admin/shifts')
      .set(auth(s.admin.token))
      .send({ name: 'Backwards', schedule: bad, bufferMin: 10 });
    expect(r.status).toBe(400);
  });

  it('400 on out-of-range HH:MM', async () => {
    const s = await seed();
    const bad = { ...NINE_TO_SIX, mon: { start: '24:00', end: '25:00' } };
    const r = await request(app)
      .post('/v1/admin/shifts')
      .set(auth(s.admin.token))
      .send({ name: 'Cosmic', schedule: bad, bufferMin: 10 });
    expect(r.status).toBe(400);
  });
});

describe('PATCH /v1/admin/shifts/:id', () => {
  it('rename + change bufferMin + change schedule', async () => {
    const s = await seed();
    const shift = await prisma.shift.create({
      data: { workspaceId: s.ws.id, name: 'Day', schedule: NINE_TO_SIX, bufferMin: 30 },
    });
    const r = await request(app)
      .patch(`/v1/admin/shifts/${shift.id}`)
      .set(auth(s.admin.token))
      .send({ name: 'Day (renamed)', bufferMin: 60, schedule: EMPTY_SCHEDULE });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('Day (renamed)');
    expect(r.body.bufferMin).toBe(60);
    expect(r.body.schedule.mon).toBeNull();
  });

  it('400 on empty body', async () => {
    const s = await seed();
    const shift = await prisma.shift.create({
      data: { workspaceId: s.ws.id, name: 'Day', schedule: NINE_TO_SIX, bufferMin: 30 },
    });
    const r = await request(app).patch(`/v1/admin/shifts/${shift.id}`).set(auth(s.admin.token)).send({});
    expect(r.status).toBe(400);
  });

  it('cross-workspace target → 404', async () => {
    const s = await seed();
    const shift = await prisma.shift.create({
      data: { workspaceId: s.wsOther.id, name: 'Other-WS Day', schedule: NINE_TO_SIX, bufferMin: 30 },
    });
    const r = await request(app)
      .patch(`/v1/admin/shifts/${shift.id}`)
      .set(auth(s.admin.token))
      .send({ name: 'Hax' });
    expect(r.status).toBe(404);
  });
});

describe('DELETE /v1/admin/shifts/:id', () => {
  it('drops shift; members\' shiftId nulls via onDelete', async () => {
    const s = await seed();
    const shift = await prisma.shift.create({
      data: { workspaceId: s.ws.id, name: 'Doomed', schedule: NINE_TO_SIX, bufferMin: 30 },
    });
    await prisma.user.update({ where: { id: s.mem.id }, data: { shiftId: shift.id, shiftAssignedAt: new Date() } });
    const r = await request(app).delete(`/v1/admin/shifts/${shift.id}`).set(auth(s.admin.token));
    expect(r.status).toBe(200);
    const reload = await prisma.user.findUnique({ where: { id: s.mem.id } });
    expect(reload?.shiftId).toBeNull();
  });

  it('past TimeEntry.shiftIdAtStart is PRESERVED even after shift is deleted (audit history)', async () => {
    const s = await seed();
    const shift = await prisma.shift.create({
      data: { workspaceId: s.ws.id, name: 'Snapshot', schedule: NINE_TO_SIX, bufferMin: 30 },
    });
    await prisma.user.update({ where: { id: s.mem.id }, data: { shiftId: shift.id, shiftAssignedAt: new Date() } });
    // Simulate a TimeEntry that captured the snapshot.
    const te = await prisma.timeEntry.create({
      data: {
        id: ulid(),
        clientUuid: `cu-snap-${Date.now()}`,
        userId: s.mem.id,
        source: 'AUTO',
        startedAt: new Date(),
        shiftIdAtStart: shift.id,
        segments: { create: [{ id: ulid(), kind: 'WORK', startedAt: new Date() }] },
      },
    });
    // Now drop the shift.
    await request(app).delete(`/v1/admin/shifts/${shift.id}`).set(auth(s.admin.token));
    // The historic snapshot survives.
    const reload = await prisma.timeEntry.findUnique({ where: { id: te.id } });
    expect(reload?.shiftIdAtStart).toBe(shift.id);
  });
});

describe('PATCH /v1/admin/users/:id with shiftId', () => {
  it('assigns a shift to a user, stamps shiftAssignedAt', async () => {
    const s = await seed();
    const shift = await prisma.shift.create({
      data: { workspaceId: s.ws.id, name: 'Day', schedule: NINE_TO_SIX, bufferMin: 30 },
    });
    const r = await request(app)
      .patch(`/v1/admin/users/${s.mem.id}`)
      .set(auth(s.admin.token))
      .send({ shiftId: shift.id });
    expect(r.status).toBe(200);
    const reload = await prisma.user.findUnique({ where: { id: s.mem.id } });
    expect(reload?.shiftId).toBe(shift.id);
    expect(reload?.shiftAssignedAt).not.toBeNull();
  });

  it('shiftId=null clears the assignment', async () => {
    const s = await seed();
    const shift = await prisma.shift.create({
      data: { workspaceId: s.ws.id, name: 'Day', schedule: NINE_TO_SIX, bufferMin: 30 },
    });
    await prisma.user.update({ where: { id: s.mem.id }, data: { shiftId: shift.id, shiftAssignedAt: new Date() } });
    const r = await request(app)
      .patch(`/v1/admin/users/${s.mem.id}`)
      .set(auth(s.admin.token))
      .send({ shiftId: null });
    expect(r.status).toBe(200);
    const reload = await prisma.user.findUnique({ where: { id: s.mem.id } });
    expect(reload?.shiftId).toBeNull();
    expect(reload?.shiftAssignedAt).toBeNull();
  });

  it('rejects cross-workspace shiftId', async () => {
    const s = await seed();
    const other = await prisma.shift.create({
      data: { workspaceId: s.wsOther.id, name: 'Other-WS', schedule: NINE_TO_SIX, bufferMin: 30 },
    });
    const r = await request(app)
      .patch(`/v1/admin/users/${s.mem.id}`)
      .set(auth(s.admin.token))
      .send({ shiftId: other.id });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('shift_out_of_workspace');
  });
});

describe('GET /v1/auth/me/shift', () => {
  it('returns { shift: null } when unassigned', async () => {
    const s = await seed();
    const r = await request(app).get('/v1/auth/me/shift').set(auth(s.mem.token));
    expect(r.status).toBe(200);
    expect(r.body.shift).toBeNull();
    expect(r.body.assignedAt).toBeNull();
  });

  it('returns the shift + assignedAt when assigned', async () => {
    const s = await seed();
    const shift = await prisma.shift.create({
      data: { workspaceId: s.ws.id, name: 'Day', schedule: NINE_TO_SIX, bufferMin: 45 },
    });
    await prisma.user.update({ where: { id: s.mem.id }, data: { shiftId: shift.id, shiftAssignedAt: new Date() } });
    const r = await request(app).get('/v1/auth/me/shift').set(auth(s.mem.token));
    expect(r.status).toBe(200);
    expect(r.body.shift.id).toBe(shift.id);
    expect(r.body.shift.bufferMin).toBe(45);
    expect(r.body.shift.schedule.mon).toEqual({ start: '09:00', end: '18:00' });
    expect(r.body.assignedAt).toBeTruthy();
  });
});

describe('TimeEntry.shiftIdAtStart snapshot on /v1/time-entries create', () => {
  it('stamps current shiftId at start time; later reassignment does NOT rewrite history', async () => {
    const s = await seed();
    const shiftA = await prisma.shift.create({
      data: { workspaceId: s.ws.id, name: 'A', schedule: NINE_TO_SIX, bufferMin: 30 },
    });
    const shiftB = await prisma.shift.create({
      data: { workspaceId: s.ws.id, name: 'B', schedule: NINE_TO_SIX, bufferMin: 30 },
    });
    // Assign Shift A.
    await prisma.user.update({
      where: { id: s.mem.id },
      data: { shiftId: shiftA.id, shiftAssignedAt: new Date() },
    });
    // Create a TimeEntry while on Shift A.
    const startedAt = new Date('2026-06-01T09:00:00Z').toISOString();
    const segId = `seg-${ulid()}`;
    const entryId = `te-${ulid()}`;
    const r = await request(app)
      .post('/v1/time-entries')
      .set(auth(s.mem.token))
      .send({
        id: entryId,
        clientUuid: `cu-${ulid()}`,
        source: 'AUTO',
        startedAt,
        segments: [{ id: segId, kind: 'WORK', startedAt, endedAt: null }],
      });
    expect(r.status).toBe(201);
    // Reassign to Shift B.
    await prisma.user.update({
      where: { id: s.mem.id },
      data: { shiftId: shiftB.id, shiftAssignedAt: new Date() },
    });
    // The TimeEntry still snapshots Shift A.
    const reload = await prisma.timeEntry.findUnique({ where: { id: entryId } });
    expect(reload?.shiftIdAtStart).toBe(shiftA.id);
  });
});
