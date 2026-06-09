import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';

const app = buildApp();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

let counter = 0;

async function seedManagerWorkspace() {
  counter += 1;
  const stamp = `${Date.now()}-${counter}`;
  const ws = await prisma.workspace.create({ data: { name: `Manager edit WS ${stamp}` } });
  const mk = (email: string, name: string, role: 'ADMIN' | 'MANAGER' | 'MEMBER') =>
    prisma.user.create({
      data: {
        workspaceId: ws.id,
        email: `${email}-${stamp}@test.local`,
        name,
        role,
        passwordHash: 'x'.repeat(60),
      },
    });

  const admin = await mk('admin', 'Admin Ada', 'ADMIN');
  const manager = await mk('manager', 'Manager Mira', 'MANAGER');
  const member = await mk('member', 'Member Mia', 'MEMBER');
  const outsider = await mk('outsider', 'Outside Omar', 'MEMBER');
  const team = await prisma.team.create({
    data: { workspaceId: ws.id, name: 'Manager Team', managerId: manager.id },
  });
  await prisma.user.update({
    where: { id: member.id },
    data: { teamId: team.id, managerId: manager.id },
  });

  const token = (u: { id: string; role: 'ADMIN' | 'MANAGER' | 'MEMBER' }) =>
    signAccessToken({ sub: u.id, ws: ws.id, role: u.role });

  return {
    ws,
    team,
    admin: { id: admin.id, token: token(admin) },
    manager: { id: manager.id, token: token(manager), name: manager.name },
    member: { id: member.id, token: token(member) },
    outsider: { id: outsider.id, token: token(outsider) },
  };
}

async function createEntry(userId: string, source: 'AUTO' | 'MANUAL' = 'AUTO') {
  const id = `te_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = new Date('2026-06-07T09:00:00.000Z');
  const endedAt = new Date('2026-06-07T10:00:00.000Z');
  return prisma.timeEntry.create({
    data: {
      id,
      clientUuid: `cu_${id}`,
      userId,
      source,
      larkTaskGuid: null,
      notes: null,
      startedAt,
      endedAt,
      segments: { create: [{ id: `seg_${id}`, kind: 'WORK', startedAt, endedAt }] },
    },
  });
}

function manualBody(over: Record<string, unknown> = {}) {
  return {
    clientUuid: `mtr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    requestedStart: '2026-06-07T09:00:00.000Z',
    requestedEnd: '2026-06-07T10:00:00.000Z',
    reason: 'Manager added missed time after review',
    ...over,
  };
}

describe('manager scoped Edit Time mutations', () => {
  it('manager creates approved manual time for a team member', async () => {
    const s = await seedManagerWorkspace();
    const res = await request(app)
      .post('/v1/time-requests')
      .set(bearer(s.manager.token))
      .send(manualBody({ userId: s.member.id, larkTaskGuid: 'task-team', taskSummary: 'Team task' }));

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('APPROVED');
    expect(res.body.autoApproved).toBe(true);
    expect(res.body.userId).toBe(s.member.id);
    expect(res.body.approverId).toBe(s.manager.id);
    expect(res.body.decidedReason).toBe(`Added by ${s.manager.name}`);

    const row = await prisma.manualTimeRequest.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.timeEntryId).toBeTruthy();
    const entry = await prisma.timeEntry.findUniqueOrThrow({
      where: { id: row.timeEntryId! },
      include: { segments: true },
    });
    expect(entry.userId).toBe(s.member.id);
    expect(entry.source).toBe('MANUAL');
    expect(entry.larkTaskGuid).toBe('task-team');
    expect(entry.segments).toHaveLength(1);
  });

  it('manager cannot create manual time for someone outside their team scope', async () => {
    const s = await seedManagerWorkspace();
    const res = await request(app)
      .post('/v1/time-requests')
      .set(bearer(s.manager.token))
      .send(manualBody({ userId: s.outsider.id }));

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });

  it('manager patches a team member time entry metadata', async () => {
    const s = await seedManagerWorkspace();
    const entry = await createEntry(s.member.id);

    const res = await request(app)
      .patch(`/v1/time-entries/${entry.id}`)
      .set(bearer(s.manager.token))
      .send({ larkTaskGuid: 'task-updated', notes: 'Aligned by manager' });

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(s.member.id);
    expect(res.body.larkTaskGuid).toBe('task-updated');
    expect(res.body.notes).toBe('Aligned by manager');
  });

  it('manager deletes approved manual time and cancels its linked request', async () => {
    const s = await seedManagerWorkspace();
    const entry = await createEntry(s.member.id, 'MANUAL');
    const mtr = await prisma.manualTimeRequest.create({
      data: {
        clientUuid: `mtr_linked_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        userId: s.member.id,
        approverId: s.manager.id,
        requestedStart: entry.startedAt,
        requestedEnd: entry.endedAt!,
        reason: 'Approved manual time',
        status: 'APPROVED',
        autoApproved: true,
        decidedAt: new Date('2026-06-07T10:01:00.000Z'),
        decidedReason: 'Added by manager',
        timeEntryId: entry.id,
      },
    });

    const res = await request(app)
      .delete(`/v1/time-entries/${entry.id}`)
      .set(bearer(s.manager.token));

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    await expect(prisma.timeEntry.findUnique({ where: { id: entry.id } })).resolves.toBeNull();
    const requestRow = await prisma.manualTimeRequest.findUniqueOrThrow({ where: { id: mtr.id } });
    expect(requestRow.status).toBe('CANCELLED');
    expect(requestRow.timeEntryId).toBeNull();
    expect(requestRow.decidedReason).toBe('Deleted by manager');
  });

  it('manager cannot delete auto-tracked time', async () => {
    const s = await seedManagerWorkspace();
    const entry = await createEntry(s.member.id, 'AUTO');

    const res = await request(app)
      .delete(`/v1/time-entries/${entry.id}`)
      .set(bearer(s.manager.token));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('not_manual_time');
    await expect(prisma.timeEntry.findUnique({ where: { id: entry.id } })).resolves.not.toBeNull();
  });
});
