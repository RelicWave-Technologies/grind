import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';

/**
 * M13/1: self auto-approve (MGR+) + meeting attendees + admin reopen.
 * Real Postgres, no Lark calls (best-effort messenger silently no-ops
 * when not configured in tests).
 */

const app = buildApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const iso = (s: string) => new Date(s).toISOString();

let counter = 0;
async function seed() {
  counter += 1;
  const stamp = `${Date.now()}-${counter}`;
  const ws = await prisma.workspace.create({ data: { name: `WS-m13-${stamp}` } });
  const wsOther = await prisma.workspace.create({ data: { name: `WS-other-${stamp}` } });
  const mk = (workspaceId: string, tag: string, role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER') =>
    prisma.user.create({
      data: {
        workspaceId,
        email: `${tag}-${stamp}@test.local`,
        name: `${tag} user`,
        role,
        passwordHash: 'x'.repeat(60),
      },
    });
  const owner = await mk(ws.id, 'owner', 'OWNER');
  const admin = await mk(ws.id, 'admin', 'ADMIN');
  const mgr = await mk(ws.id, 'mgr', 'MANAGER');
  const mem = await mk(ws.id, 'mem', 'MEMBER');
  const memA = await mk(ws.id, 'memA', 'MEMBER');
  const memB = await mk(ws.id, 'memB', 'MEMBER');
  const outsider = await mk(wsOther.id, 'out', 'MEMBER');

  const tok = (u: { id: string; role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER' }, wsId = ws.id) =>
    signAccessToken({ sub: u.id, ws: wsId, role: u.role });

  return {
    ws,
    wsOther,
    owner: { id: owner.id, token: tok(owner) },
    admin: { id: admin.id, token: tok(admin) },
    mgr: { id: mgr.id, token: tok(mgr) },
    mem: { id: mem.id, token: tok(mem) },
    memA: { id: memA.id, token: tok(memA) },
    memB: { id: memB.id, token: tok(memB) },
    outsider: { id: outsider.id, token: tok(outsider, wsOther.id) },
  };
}

const sample = {
  requestedStart: iso('2026-06-10T09:00:00Z'),
  requestedEnd: iso('2026-06-10T10:00:00Z'),
  reason: 'Forgot to start the tracker — design review.',
};

describe('POST /v1/time-requests — self auto-approve', () => {
  it('MANAGER auto-approves: status APPROVED + autoApproved=true + TimeEntry created', async () => {
    const s = await seed();
    const res = await request(app)
      .post('/v1/time-requests')
      .set(auth(s.mgr.token))
      .send({ clientUuid: `cu-${ulid()}`, ...sample });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('APPROVED');
    expect(res.body.autoApproved).toBe(true);
    expect(res.body.approverId).toBe(s.mgr.id);
    // TimeEntry should exist linked to the request.
    const row = await prisma.manualTimeRequest.findUnique({ where: { id: res.body.id } });
    expect(row?.timeEntryId).toBeTruthy();
    const te = await prisma.timeEntry.findUnique({
      where: { id: row!.timeEntryId! },
      include: { segments: true },
    });
    expect(te?.source).toBe('MANUAL');
    expect(te?.segments).toHaveLength(1);
    expect(te?.segments[0]?.kind).toBe('WORK');
  });

  it('ADMIN and OWNER also auto-approve', async () => {
    const s = await seed();
    for (const role of [s.admin, s.owner]) {
      const res = await request(app)
        .post('/v1/time-requests')
        .set(auth(role.token))
        .send({ clientUuid: `cu-${ulid()}`, ...sample });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('APPROVED');
      expect(res.body.autoApproved).toBe(true);
    }
  });

  it('MEMBER stays PENDING (traditional approver flow)', async () => {
    const s = await seed();
    const res = await request(app)
      .post('/v1/time-requests')
      .set(auth(s.mem.token))
      .send({ clientUuid: `cu-${ulid()}`, ...sample });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.autoApproved).toBe(false);
    expect(res.body.approverId).not.toBe(s.mem.id);
  });

  it('snapshots requester.shiftId at start time', async () => {
    const s = await seed();
    const shift = await prisma.shift.create({
      data: {
        workspaceId: s.ws.id,
        name: 'Day',
        schedule: {
          mon: { start: '09:00', end: '18:00' },
          tue: { start: '09:00', end: '18:00' },
          wed: { start: '09:00', end: '18:00' },
          thu: { start: '09:00', end: '18:00' },
          fri: { start: '09:00', end: '18:00' },
          sat: null,
          sun: null,
        },
        bufferMin: 30,
      },
    });
    await prisma.user.update({ where: { id: s.mgr.id }, data: { shiftId: shift.id, shiftAssignedAt: new Date() } });
    const res = await request(app)
      .post('/v1/time-requests')
      .set(auth(s.mgr.token))
      .send({ clientUuid: `cu-${ulid()}`, ...sample });
    expect(res.status).toBe(201);
    const row = await prisma.manualTimeRequest.findUnique({ where: { id: res.body.id } });
    const te = await prisma.timeEntry.findUnique({ where: { id: row!.timeEntryId! } });
    expect(te?.shiftIdAtStart).toBe(shift.id);
  });
});

describe('POST /v1/time-requests — attendees', () => {
  it('persists attendeeIds (deduped, self excluded)', async () => {
    const s = await seed();
    const res = await request(app)
      .post('/v1/time-requests')
      .set(auth(s.mgr.token))
      .send({
        clientUuid: `cu-${ulid()}`,
        ...sample,
        attendeeIds: [s.memA.id, s.memB.id, s.memA.id /* dupe */, s.mgr.id /* self */],
      });
    expect(res.status).toBe(201);
    const ids = (res.body.attendeeIds as string[]).sort();
    expect(ids).toEqual([s.memA.id, s.memB.id].sort());
    // Should also propagate to the linked TimeEntry.
    const row = await prisma.manualTimeRequest.findUnique({ where: { id: res.body.id } });
    const teAttendees = await prisma.timeEntryAttendee.findMany({
      where: { timeEntryId: row!.timeEntryId! },
    });
    expect(teAttendees.map((a) => a.userId).sort()).toEqual([s.memA.id, s.memB.id].sort());
  });

  it('400 on cross-workspace attendee', async () => {
    const s = await seed();
    const res = await request(app)
      .post('/v1/time-requests')
      .set(auth(s.mgr.token))
      .send({ clientUuid: `cu-${ulid()}`, ...sample, attendeeIds: [s.outsider.id] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('attendee_out_of_workspace');
  });

  it('empty array is OK (no attendees)', async () => {
    const s = await seed();
    const res = await request(app)
      .post('/v1/time-requests')
      .set(auth(s.mgr.token))
      .send({ clientUuid: `cu-${ulid()}`, ...sample, attendeeIds: [] });
    expect(res.status).toBe(201);
    expect(res.body.attendeeIds ?? []).toEqual([]);
  });

  it('MEMBER request also stores attendees and they show up on approval', async () => {
    const s = await seed();
    const r1 = await request(app)
      .post('/v1/time-requests')
      .set(auth(s.mem.token))
      .send({ clientUuid: `cu-${ulid()}`, ...sample, attendeeIds: [s.memA.id, s.memB.id] });
    expect(r1.status).toBe(201);
    expect(r1.body.status).toBe('PENDING');
    expect((r1.body.attendeeIds as string[]).sort()).toEqual([s.memA.id, s.memB.id].sort());
    // Decide via admin endpoint → TimeEntry should inherit attendees.
    const decide = await request(app)
      .post(`/v1/admin/manual-time-requests/${r1.body.id}/decide`)
      .set(auth(s.admin.token))
      .send({ action: 'approve' });
    expect(decide.status).toBe(200);
    const reload = await prisma.manualTimeRequest.findUnique({
      where: { id: r1.body.id },
      include: { attendees: true },
    });
    expect(reload!.attendees.map((a) => a.userId).sort()).toEqual([s.memA.id, s.memB.id].sort());
    // The approved TimeEntry MUST inherit those attendees (meeting participants)
    // — parity with the auto-approve path. Regression guard for the M13/2 wiring
    // that decideByUser previously skipped (attendees were silently dropped).
    const teAttendees = await prisma.timeEntryAttendee.findMany({
      where: { timeEntryId: reload!.timeEntryId! },
    });
    expect(teAttendees.map((a) => a.userId).sort()).toEqual([s.memA.id, s.memB.id].sort());
  });
});

describe('POST /v1/admin/manual-time-requests/:id/reopen', () => {
  it('ADMIN reopens an auto-approved request within 24h → PENDING + TimeEntry dropped', async () => {
    const s = await seed();
    const r = await request(app)
      .post('/v1/time-requests')
      .set(auth(s.mgr.token))
      .send({ clientUuid: `cu-${ulid()}`, ...sample });
    expect(r.status).toBe(201);
    const id = r.body.id;
    const teId = (await prisma.manualTimeRequest.findUnique({ where: { id } }))!.timeEntryId!;
    expect(await prisma.timeEntry.findUnique({ where: { id: teId } })).not.toBeNull();

    const reopen = await request(app)
      .post(`/v1/admin/manual-time-requests/${id}/reopen`)
      .set(auth(s.admin.token));
    expect(reopen.status).toBe(200);
    expect(reopen.body.status).toBe('PENDING');
    expect(reopen.body.autoApproved).toBe(false);
    expect(await prisma.timeEntry.findUnique({ where: { id: teId } })).toBeNull();
  });

  it('MANAGER cannot reopen — admin-only', async () => {
    const s = await seed();
    const r = await request(app)
      .post('/v1/time-requests')
      .set(auth(s.admin.token))
      .send({ clientUuid: `cu-${ulid()}`, ...sample });
    const reopen = await request(app)
      .post(`/v1/admin/manual-time-requests/${r.body.id}/reopen`)
      .set(auth(s.mgr.token));
    expect(reopen.status).toBe(403);
  });

  it('refuses to reopen a HUMAN-approved request (autoApproved=false)', async () => {
    const s = await seed();
    // MEMBER creates → PENDING → admin /decide approves manually
    const r = await request(app)
      .post('/v1/time-requests')
      .set(auth(s.mem.token))
      .send({ clientUuid: `cu-${ulid()}`, ...sample });
    await request(app)
      .post(`/v1/admin/manual-time-requests/${r.body.id}/decide`)
      .set(auth(s.admin.token))
      .send({ action: 'approve' });
    const reopen = await request(app)
      .post(`/v1/admin/manual-time-requests/${r.body.id}/reopen`)
      .set(auth(s.admin.token));
    expect(reopen.status).toBe(409);
    expect(reopen.body.error).toBe('not_auto_approved');
  });

  it('refuses to reopen after the 24h window', async () => {
    const s = await seed();
    const r = await request(app)
      .post('/v1/time-requests')
      .set(auth(s.mgr.token))
      .send({ clientUuid: `cu-${ulid()}`, ...sample });
    // Push decidedAt 25h back in time.
    await prisma.manualTimeRequest.update({
      where: { id: r.body.id },
      data: { decidedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });
    const reopen = await request(app)
      .post(`/v1/admin/manual-time-requests/${r.body.id}/reopen`)
      .set(auth(s.admin.token));
    expect(reopen.status).toBe(409);
    expect(reopen.body.error).toBe('reopen_window_expired');
  });

  it('cross-workspace target → 404', async () => {
    const s = await seed();
    // Make a row in the other workspace.
    const otherOwner = await prisma.user.create({
      data: {
        workspaceId: s.wsOther.id,
        email: `wsOther-mgr-${Date.now()}@t.l`,
        name: 'wsOther-mgr',
        role: 'MANAGER',
        passwordHash: 'x'.repeat(60),
      },
    });
    const tok = signAccessToken({ sub: otherOwner.id, ws: s.wsOther.id, role: 'MANAGER' });
    const r = await request(app)
      .post('/v1/time-requests')
      .set(auth(tok))
      .send({ clientUuid: `cu-${ulid()}`, ...sample });
    const reopen = await request(app)
      .post(`/v1/admin/manual-time-requests/${r.body.id}/reopen`)
      .set(auth(s.admin.token));
    expect(reopen.status).toBe(404);
  });
});

describe('PATCH /v1/time-entries/:id — attendees', () => {
  it('400 on a WORK-only entry (no MEETING segment)', async () => {
    const s = await seed();
    const startedAt = iso('2026-06-10T09:00:00Z');
    const te = await prisma.timeEntry.create({
      data: {
        id: `te-${ulid()}`,
        clientUuid: `cu-${ulid()}`,
        userId: s.mgr.id,
        source: 'AUTO',
        startedAt: new Date(startedAt),
        segments: { create: [{ id: `seg-${ulid()}`, kind: 'WORK', startedAt: new Date(startedAt) }] },
      },
    });
    const r = await request(app)
      .patch(`/v1/time-entries/${te.id}`)
      .set(auth(s.mgr.token))
      .send({ attendeeIds: [s.memA.id] });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('attendees_require_meeting_segment');
  });

  it('OK on a MEETING entry, replaces existing attendees', async () => {
    const s = await seed();
    const startedAt = iso('2026-06-10T11:00:00Z');
    const te = await prisma.timeEntry.create({
      data: {
        id: `te-${ulid()}`,
        clientUuid: `cu-${ulid()}`,
        userId: s.mgr.id,
        source: 'AUTO',
        startedAt: new Date(startedAt),
        segments: {
          create: [{ id: `seg-${ulid()}`, kind: 'MEETING', startedAt: new Date(startedAt) }],
        },
        attendees: { create: [{ userId: s.memA.id }] },
      },
    });
    const r = await request(app)
      .patch(`/v1/time-entries/${te.id}`)
      .set(auth(s.mgr.token))
      .send({ attendeeIds: [s.memB.id] }); // replace A with B
    expect(r.status).toBe(200);
    const reload = await prisma.timeEntryAttendee.findMany({ where: { timeEntryId: te.id } });
    expect(reload.map((a) => a.userId)).toEqual([s.memB.id]);
  });

  it('400 on cross-workspace attendee', async () => {
    const s = await seed();
    const te = await prisma.timeEntry.create({
      data: {
        id: `te-${ulid()}`,
        clientUuid: `cu-${ulid()}`,
        userId: s.mgr.id,
        source: 'AUTO',
        startedAt: new Date(),
        segments: { create: [{ id: `seg-${ulid()}`, kind: 'MEETING', startedAt: new Date() }] },
      },
    });
    const r = await request(app)
      .patch(`/v1/time-entries/${te.id}`)
      .set(auth(s.mgr.token))
      .send({ attendeeIds: [s.outsider.id] });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('attendee_out_of_workspace');
  });
});
