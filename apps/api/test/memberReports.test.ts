import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';
import { NINE_TO_SIX } from '@grind/types';

const app = buildApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const iso = (s: string) => new Date(s);

let counter = 0;

async function seedReportDay() {
  counter += 1;
  const stamp = `${Date.now()}-${counter}`;
  const ws = await prisma.workspace.create({ data: { name: `WS-report-${stamp}` } });
  const member = await prisma.user.create({
    data: {
      workspaceId: ws.id,
      email: `member-${stamp}@test.local`,
      name: 'Member Reports',
      role: 'MEMBER',
      passwordHash: 'x'.repeat(60),
    },
  });
  const admin = await prisma.user.create({
    data: {
      workspaceId: ws.id,
      email: `admin-${stamp}@test.local`,
      name: 'Admin Reports',
      role: 'ADMIN',
      passwordHash: 'x'.repeat(60),
    },
  });
  const other = await prisma.user.create({
    data: {
      workspaceId: ws.id,
      email: `other-${stamp}@test.local`,
      name: 'Other Member',
      role: 'MEMBER',
      passwordHash: 'x'.repeat(60),
    },
  });
  await prisma.shiftAssignment.create({
    data: {
      userId: member.id,
      shiftId: `shift-${stamp}`,
      effectiveFrom: iso('2026-05-30T00:00:00Z'),
      shiftNameSnapshot: 'Day',
      scheduleSnapshot: NINE_TO_SIX,
      bufferMinSnapshot: 15,
    },
  });

  const autoEntry = await prisma.timeEntry.create({
    data: {
      id: ulid(),
      clientUuid: `auto-${ulid()}`,
      userId: member.id,
      source: 'AUTO',
      startedAt: iso('2026-06-01T09:10:00Z'),
      endedAt: iso('2026-06-01T12:00:00Z'),
      segments: {
        create: [
          { id: ulid(), kind: 'WORK', startedAt: iso('2026-06-01T09:10:00Z'), endedAt: iso('2026-06-01T10:00:00Z') },
          { id: ulid(), kind: 'IDLE_TRIMMED', startedAt: iso('2026-06-01T10:00:00Z'), endedAt: iso('2026-06-01T10:15:00Z') },
          { id: ulid(), kind: 'MEETING', startedAt: iso('2026-06-01T10:15:00Z'), endedAt: iso('2026-06-01T11:00:00Z') },
          { id: ulid(), kind: 'WORK', startedAt: iso('2026-06-01T11:00:00Z'), endedAt: iso('2026-06-01T12:00:00Z') },
        ],
      },
    },
  });
  const manualEntry = await prisma.timeEntry.create({
    data: {
      id: ulid(),
      clientUuid: `manual-${ulid()}`,
      userId: member.id,
      source: 'MANUAL',
      startedAt: iso('2026-06-01T13:00:00Z'),
      endedAt: iso('2026-06-01T14:00:00Z'),
      segments: {
        create: [{ id: ulid(), kind: 'WORK', startedAt: iso('2026-06-01T13:00:00Z'), endedAt: iso('2026-06-01T14:00:00Z') }],
      },
    },
  });
  await prisma.manualTimeRequest.createMany({
    data: [
      {
        clientUuid: `mtr-approved-${ulid()}`,
        userId: member.id,
        approverId: admin.id,
        requestedStart: iso('2026-06-01T13:00:00Z'),
        requestedEnd: iso('2026-06-01T14:00:00Z'),
        reason: 'Approved manual',
        status: 'APPROVED',
        decidedAt: iso('2026-06-01T14:05:00Z'),
        timeEntryId: manualEntry.id,
      },
      {
        clientUuid: `mtr-pending-${ulid()}`,
        userId: member.id,
        approverId: admin.id,
        requestedStart: iso('2026-06-01T15:00:00Z'),
        requestedEnd: iso('2026-06-01T15:30:00Z'),
        reason: 'Pending manual',
        status: 'PENDING',
      },
      {
        clientUuid: `mtr-rejected-${ulid()}`,
        userId: member.id,
        approverId: admin.id,
        requestedStart: iso('2026-06-01T16:00:00Z'),
        requestedEnd: iso('2026-06-01T16:30:00Z'),
        reason: 'Rejected manual',
        status: 'REJECTED',
        decidedAt: iso('2026-06-01T16:35:00Z'),
        decidedReason: 'No evidence',
      },
      {
        clientUuid: `mtr-cancelled-${ulid()}`,
        userId: member.id,
        approverId: admin.id,
        requestedStart: iso('2026-06-01T17:00:00Z'),
        requestedEnd: iso('2026-06-01T17:30:00Z'),
        reason: 'Cancelled manual',
        status: 'CANCELLED',
      },
    ],
  });
  await prisma.activitySample.createMany({
    data: [
      {
        id: ulid(),
        userId: member.id,
        timeEntryId: autoEntry.id,
        bucketStart: iso('2026-06-01T09:10:00Z'),
        keystrokes: 12,
        clicks: 4,
        mouseDistancePx: 600,
        scrollEvents: 1,
        activeApp: 'Code',
        activeAppBundle: 'com.microsoft.VSCode',
      },
      {
        id: ulid(),
        userId: member.id,
        timeEntryId: autoEntry.id,
        bucketStart: iso('2026-06-01T09:11:00Z'),
        keystrokes: 8,
        clicks: 2,
        mouseDistancePx: 500,
        scrollEvents: 3,
        activeApp: 'Code',
        activeAppBundle: 'com.microsoft.VSCode',
      },
      {
        id: ulid(),
        userId: member.id,
        timeEntryId: autoEntry.id,
        bucketStart: iso('2026-06-01T10:16:00Z'),
        keystrokes: 0,
        clicks: 1,
        mouseDistancePx: 120,
        scrollEvents: 8,
        activeApp: 'Meet',
        activeAppBundle: 'com.google.meet',
      },
    ],
  });
  await prisma.screenshot.createMany({
    data: [
      {
        id: `shot-${ulid()}`,
        userId: member.id,
        timeEntryId: autoEntry.id,
        capturedAt: iso('2026-06-01T09:10:30Z'),
        fullUrl: 'https://assets.example.test/member.webp',
        thumbUrl: 'https://assets.example.test/member-thumb.webp',
        uploadState: 'UPLOADED',
      },
      {
        id: `shot-other-${ulid()}`,
        userId: other.id,
        capturedAt: iso('2026-06-01T09:10:30Z'),
        fullUrl: 'https://assets.example.test/other.webp',
        uploadState: 'UPLOADED',
      },
    ],
  });

  return {
    member,
    admin,
    memberToken: signAccessToken({ sub: member.id, ws: ws.id, role: 'MEMBER' }),
    adminToken: signAccessToken({ sub: admin.id, ws: ws.id, role: 'ADMIN' }),
  };
}

async function seedTeamReport() {
  counter += 1;
  const stamp = `${Date.now()}-${counter}`;
  const ws = await prisma.workspace.create({ data: { name: `WS-team-report-${stamp}` } });
  const manager = await prisma.user.create({
    data: {
      workspaceId: ws.id,
      email: `manager-${stamp}@test.local`,
      name: 'Manager Reports',
      role: 'MANAGER',
      passwordHash: 'x'.repeat(60),
    },
  });
  const member = await prisma.user.create({
    data: {
      workspaceId: ws.id,
      email: `team-member-${stamp}@test.local`,
      name: 'Team Member',
      role: 'MEMBER',
      managerId: manager.id,
      passwordHash: 'x'.repeat(60),
    },
  });
  const otherManager = await prisma.user.create({
    data: {
      workspaceId: ws.id,
      email: `other-manager-${stamp}@test.local`,
      name: 'Other Manager',
      role: 'MANAGER',
      passwordHash: 'x'.repeat(60),
    },
  });
  const outsider = await prisma.user.create({
    data: {
      workspaceId: ws.id,
      email: `outsider-${stamp}@test.local`,
      name: 'Outside Member',
      role: 'MEMBER',
      managerId: otherManager.id,
      passwordHash: 'x'.repeat(60),
    },
  });
  const team = await prisma.team.create({
    data: { workspaceId: ws.id, name: 'Reports Team', managerId: manager.id },
  });
  const otherTeam = await prisma.team.create({
    data: { workspaceId: ws.id, name: 'Other Team', managerId: otherManager.id },
  });
  await prisma.user.update({ where: { id: member.id }, data: { teamId: team.id } });
  await prisma.user.update({ where: { id: outsider.id }, data: { teamId: otherTeam.id } });
  await prisma.shiftAssignment.create({
    data: {
      userId: member.id,
      shiftId: `team-shift-${stamp}`,
      effectiveFrom: iso('2026-05-30T00:00:00Z'),
      shiftNameSnapshot: 'Day',
      scheduleSnapshot: NINE_TO_SIX,
      bufferMinSnapshot: 15,
    },
  });

  const memberEntry = await prisma.timeEntry.create({
    data: {
      id: ulid(),
      clientUuid: `team-auto-${ulid()}`,
      userId: member.id,
      source: 'AUTO',
      startedAt: iso('2026-06-01T09:05:00Z'),
      endedAt: iso('2026-06-01T10:05:00Z'),
      segments: {
        create: [
          { id: ulid(), kind: 'WORK', startedAt: iso('2026-06-01T09:05:00Z'), endedAt: iso('2026-06-01T10:05:00Z') },
        ],
      },
    },
  });
  await prisma.timeEntry.create({
    data: {
      id: ulid(),
      clientUuid: `outsider-auto-${ulid()}`,
      userId: outsider.id,
      source: 'AUTO',
      startedAt: iso('2026-06-01T09:00:00Z'),
      endedAt: iso('2026-06-01T12:00:00Z'),
      segments: {
        create: [
          { id: ulid(), kind: 'WORK', startedAt: iso('2026-06-01T09:00:00Z'), endedAt: iso('2026-06-01T12:00:00Z') },
        ],
      },
    },
  });
  await prisma.manualTimeRequest.create({
    data: {
      clientUuid: `team-pending-${ulid()}`,
      userId: member.id,
      approverId: manager.id,
      requestedStart: iso('2026-06-01T11:00:00Z'),
      requestedEnd: iso('2026-06-01T11:30:00Z'),
      reason: 'Team pending',
      status: 'PENDING',
    },
  });
  await prisma.activitySample.create({
    data: {
      id: ulid(),
      userId: member.id,
      timeEntryId: memberEntry.id,
      bucketStart: iso('2026-06-01T09:06:00Z'),
      keystrokes: 10,
      clicks: 3,
      mouseDistancePx: 420,
      scrollEvents: 2,
      activeApp: 'Code',
      activeAppBundle: 'com.microsoft.VSCode',
    },
  });
  await prisma.screenshot.create({
    data: {
      id: `team-shot-${ulid()}`,
      userId: member.id,
      timeEntryId: memberEntry.id,
      capturedAt: iso('2026-06-01T09:06:30Z'),
      fullUrl: 'https://assets.example.test/team.webp',
      uploadState: 'UPLOADED',
    },
  });

  return {
    manager,
    member,
    outsider,
    managerToken: signAccessToken({ sub: manager.id, ws: ws.id, role: 'MANAGER' }),
    memberToken: signAccessToken({ sub: member.id, ws: ws.id, role: 'MEMBER' }),
  };
}

describe('/v1/reports/me', () => {
  it('returns one self-scoped day row with totals, approvals, apps, screenshots, and shift status', async () => {
    const s = await seedReportDay();
    const res = await request(app)
      .get('/v1/reports/me?from=2026-06-01&to=2026-06-01&tz=UTC')
      .set(auth(s.memberToken));
    expect(res.status).toBe(200);
    expect(res.body.days).toHaveLength(1);
    const day = res.body.days[0];
    expect(day.date).toBe('2026-06-01');
    expect(day.workedMs).toBe(110 * 60_000);
    expect(day.meetingMs).toBe(45 * 60_000);
    expect(day.manualMs).toBe(60 * 60_000);
    expect(day.shiftStatus).toBe('on_time');
    expect(day.gaps.count).toBeGreaterThanOrEqual(1);
    expect(day.approvals).toEqual({ approved: 1, pending: 1, rejected: 1 });
    expect(day.screenshots.count).toBe(1);
    expect(day.topApps[0].app).toBe('Code');
    expect(day.activityPercent).not.toBeNull();
  });

  it('rejects invalid and overlong ranges', async () => {
    const s = await seedReportDay();
    const badDate = await request(app)
      .get('/v1/reports/me?from=2026-02-30&to=2026-03-01&tz=UTC')
      .set(auth(s.memberToken));
    expect(badDate.status).toBe(400);

    const tooLong = await request(app)
      .get('/v1/reports/me?from=2026-01-01&to=2026-03-15&tz=UTC')
      .set(auth(s.memberToken));
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error).toBe('range_too_long');
  });

  it('returns full app detail and only the signed-in member screenshots', async () => {
    const s = await seedReportDay();
    const apps = await request(app)
      .get('/v1/reports/me/day-apps?date=2026-06-01&tz=UTC')
      .set(auth(s.memberToken));
    expect(apps.status).toBe(200);
    expect(apps.body.apps.map((a: { app: string }) => a.app)).toContain('Code');
    expect(apps.body.apps[0].keystrokes).toBeGreaterThan(0);

    const shots = await request(app)
      .get('/v1/reports/me/day-screenshots?date=2026-06-01&tz=UTC')
      .set(auth(s.memberToken));
    expect(shots.status).toBe(200);
    expect(shots.body.screenshots).toHaveLength(1);
    expect(shots.body.screenshots[0].fullUrl).toContain('member.webp');
    expect(shots.body.screenshots[0].dominantApp).toBe('Code');
  });

  it('member has reports.self.read but not people.read', async () => {
    const s = await seedReportDay();
    const me = await request(app).get('/v1/auth/me').set(auth(s.memberToken));
    expect(me.status).toBe(200);
    expect(me.body.user.displayRole).toBe('MEMBER');
    expect(me.body.user.capabilities).toContain('profile.self.read');
    expect(me.body.user.capabilities).toContain('reports.self.read');
    expect(me.body.user.capabilities).not.toContain('people.read');
  });
});

describe('/v1/reports/team', () => {
  it('returns a manager-scoped team report without leaking other teams or self', async () => {
    const s = await seedTeamReport();
    const res = await request(app)
      .get('/v1/reports/team?from=2026-06-01&to=2026-06-01&tz=UTC')
      .set(auth(s.managerToken));
    expect(res.status).toBe(200);
    expect(res.body.summary.memberCount).toBe(1);
    expect(res.body.members).toHaveLength(1);
    expect(res.body.members[0].user.id).toBe(s.member.id);
    expect(res.body.members.map((m: { user: { id: string } }) => m.user.id)).not.toContain(s.manager.id);
    expect(res.body.members.map((m: { user: { id: string } }) => m.user.id)).not.toContain(s.outsider.id);
    expect(res.body.members[0].workedMs).toBe(60 * 60_000);
    expect(res.body.members[0].onTimeDays).toBe(1);
    expect(res.body.members[0].offDays).toBe(0);
    expect(res.body.members[0].approvals.pending).toBe(1);
    expect(res.body.members[0].screenshots).toBe(1);
    expect(res.body.members[0].days[0].topApps[0].app).toBe('Code');
    expect(res.body.attention.some((item: { kind: string }) => item.kind === 'pending_approval')).toBe(true);
  });

  it('flags automatic tracked time when activity samples are missing', async () => {
    const s = await seedTeamReport();
    await prisma.activitySample.deleteMany({ where: { userId: s.member.id } });

    const res = await request(app)
      .get('/v1/reports/team?from=2026-06-01&to=2026-06-01&tz=UTC')
      .set(auth(s.managerToken));

    expect(res.status).toBe(200);
    expect(res.body.members[0].days[0].activityPercent).toBeNull();
    expect(res.body.attention).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: s.member.id,
          date: '2026-06-01',
          kind: 'missing_activity',
          severity: 'warn',
        }),
      ]),
    );
  });

  it('returns scoped member drawer data and day details for managers only', async () => {
    const s = await seedTeamReport();
    const params = new URLSearchParams({
      userId: s.member.id,
      from: '2026-06-01',
      to: '2026-06-01',
      tz: 'UTC',
    });
    const detail = await request(app)
      .get(`/v1/reports/team/member?${params.toString()}`)
      .set(auth(s.managerToken));
    expect(detail.status).toBe(200);
    expect(detail.body.member.user.id).toBe(s.member.id);
    expect(detail.body.member.onTimeDays).toBe(1);
    expect(detail.body.member.offDays).toBe(0);
    expect(detail.body.approvals).toHaveLength(1);
    expect(detail.body.approvals[0].status).toBe('PENDING');
    expect(detail.body.profile.user.id).toBe(s.member.id);
    expect(detail.body.profile.team.name).toBe('Reports Team');

    const apps = await request(app)
      .get(`/v1/reports/team/member/day-apps?${new URLSearchParams({ userId: s.member.id, date: '2026-06-01', tz: 'UTC' }).toString()}`)
      .set(auth(s.managerToken));
    expect(apps.status).toBe(200);
    expect(apps.body.apps[0].app).toBe('Code');

    const shots = await request(app)
      .get(`/v1/reports/team/member/day-screenshots?${new URLSearchParams({ userId: s.member.id, date: '2026-06-01', tz: 'UTC' }).toString()}`)
      .set(auth(s.managerToken));
    expect(shots.status).toBe(200);
    expect(shots.body.screenshots).toHaveLength(1);
    expect(shots.body.screenshots[0].fullUrl).toContain('team.webp');

    const memberDenied = await request(app)
      .get(`/v1/reports/team/member?${params.toString()}`)
      .set(auth(s.memberToken));
    expect(memberDenied.status).toBe(403);

    const outsiderParams = new URLSearchParams({
      userId: s.outsider.id,
      from: '2026-06-01',
      to: '2026-06-01',
      tz: 'UTC',
    });
    const outsiderDenied = await request(app)
      .get(`/v1/reports/team/member?${outsiderParams.toString()}`)
      .set(auth(s.managerToken));
    expect(outsiderDenied.status).toBe(403);
  });

  it('rejects members and overlong team ranges', async () => {
    const s = await seedTeamReport();
    const memberRes = await request(app)
      .get('/v1/reports/team?from=2026-06-01&to=2026-06-01&tz=UTC')
      .set(auth(s.memberToken));
    expect(memberRes.status).toBe(403);

    const tooLong = await request(app)
      .get('/v1/reports/team?from=2026-06-01&to=2026-07-10&tz=UTC')
      .set(auth(s.managerToken));
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error).toBe('range_too_long');
    expect(tooLong.body.maxDays).toBe(31);
  });
});
