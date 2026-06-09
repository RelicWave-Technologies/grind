import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';
import { ulid } from 'ulid';

const app = buildApp();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const HOUR = 60 * 60 * 1000;

let counter = 0;
async function seed() {
  counter += 1;
  const stamp = `${Date.now()}-${counter}-pay`;
  const ws = await prisma.workspace.create({ data: { name: `WS ${stamp}` } });
  const mk = (email: string, role: 'ADMIN' | 'MANAGER' | 'MEMBER') =>
    prisma.user.create({
      data: {
        workspaceId: ws.id,
        email: `${email}-${stamp}@test.local`,
        name: email,
        role,
        passwordHash: 'x'.repeat(60),
      },
    });
  const admin = await mk('admin', 'ADMIN');
  const member = await mk('mem', 'MEMBER');
  const token = (u: { id: string; role: 'ADMIN' | 'MANAGER' | 'MEMBER' }) =>
    signAccessToken({ sub: u.id, ws: ws.id, role: u.role });
  return {
    ws,
    admin: { id: admin.id, token: token(admin) },
    member: { id: member.id, token: token(member) },
  };
}

async function seedEntry(opts: {
  userId: string;
  source: 'AUTO' | 'MANUAL';
  segmentKind: 'WORK' | 'MEETING' | 'IDLE_TRIMMED';
  startedAt: Date;
  endedAt: Date;
}) {
  return prisma.timeEntry.create({
    data: {
      id: ulid(),
      clientUuid: ulid(),
      userId: opts.userId,
      source: opts.source,
      startedAt: opts.startedAt,
      endedAt: opts.endedAt,
      agentVersion: '0.0.0',
      platform: 'test',
      segments: {
        create: [
          {
            id: ulid(),
            kind: opts.segmentKind,
            startedAt: opts.startedAt,
            endedAt: opts.endedAt,
          },
        ],
      },
    },
  });
}

describe('GET /v1/admin/payroll/monthly', () => {
  it('rejects MEMBER (admin-only)', async () => {
    const { member } = await seed();
    const res = await request(app)
      .get('/v1/admin/payroll/monthly?month=2026-05')
      .set(bearer(member.token));
    expect(res.status).toBe(403);
  });

  it('400 on malformed month', async () => {
    const { admin } = await seed();
    const res = await request(app)
      .get('/v1/admin/payroll/monthly?month=05-2026')
      .set(bearer(admin.token));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_month');
  });

  it('returns rows for every user even without tracked time', async () => {
    const { admin } = await seed();
    const res = await request(app)
      .get('/v1/admin/payroll/monthly?month=2026-05&tz=UTC')
      .set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.payroll.month).toBe('2026-05');
    // 2 users (admin + member), each with 0 hours.
    expect(res.body.payroll.rows).toHaveLength(2);
    for (const row of res.body.payroll.rows) {
      expect(row.totalHours).toBe(0);
      expect(row.daysPresent).toBe(0);
    }
    expect(res.body.policy.halfDayUpperMin).toBe(res.body.policy.fullDayLowerMin);
  });

  it('sums hours per user with correct day-presence count', async () => {
    const { admin, member } = await seed();
    // Member: 2 days, ~8h worked + 1h meeting + 2h manual on day 1; 4h worked on day 2.
    await seedEntry({
      userId: member.id,
      source: 'AUTO',
      segmentKind: 'WORK',
      startedAt: new Date('2026-05-04T09:00:00Z'),
      endedAt: new Date('2026-05-04T17:00:00Z'),
    });
    await seedEntry({
      userId: member.id,
      source: 'AUTO',
      segmentKind: 'MEETING',
      startedAt: new Date('2026-05-04T13:00:00Z'),
      endedAt: new Date('2026-05-04T14:00:00Z'),
    });
    await seedEntry({
      userId: member.id,
      source: 'MANUAL',
      segmentKind: 'WORK', // MANUAL source collapses to manual regardless of segment.kind
      startedAt: new Date('2026-05-04T18:00:00Z'),
      endedAt: new Date('2026-05-04T20:00:00Z'),
    });
    await seedEntry({
      userId: member.id,
      source: 'AUTO',
      segmentKind: 'WORK',
      startedAt: new Date('2026-05-05T09:00:00Z'),
      endedAt: new Date('2026-05-05T13:00:00Z'),
    });

    const res = await request(app)
      .get('/v1/admin/payroll/monthly?month=2026-05&tz=UTC')
      .set(bearer(admin.token));
    expect(res.status).toBe(200);
    const memberRow = res.body.payroll.rows.find((r: { user: { id: string } }) => r.user.id === member.id);
    expect(memberRow).toBeDefined();
    expect(memberRow.daysPresent).toBe(2);
    expect(memberRow.workedHours).toBe(12); // 8 + 4
    expect(memberRow.meetingHours).toBe(1);
    expect(memberRow.manualHours).toBe(2);
    expect(memberRow.totalHours).toBe(15);
  });

  it('isolates by workspace', async () => {
    const wsA = await seed();
    const wsB = await seed();
    await seedEntry({
      userId: wsB.member.id,
      source: 'AUTO',
      segmentKind: 'WORK',
      startedAt: new Date('2026-05-04T09:00:00Z'),
      endedAt: new Date('2026-05-04T17:00:00Z'),
    });
    const res = await request(app)
      .get('/v1/admin/payroll/monthly?month=2026-05&tz=UTC')
      .set(bearer(wsA.admin.token));
    expect(res.status).toBe(200);
    expect(res.body.payroll.totals.totalHours).toBe(0);
  });
});

describe('/v1/admin/payroll/policy', () => {
  it('returns defaults and rejects invalid threshold joins', async () => {
    const { admin } = await seed();
    const getRes = await request(app).get('/v1/admin/payroll/policy').set(bearer(admin.token));
    expect(getRes.status).toBe(200);
    expect(getRes.body.approvalReminderDays).toEqual([3, 4]);
    expect(getRes.body.payrollSheetSendDay).toBe(5);

    const bad = await request(app)
      .patch('/v1/admin/payroll/policy')
      .set(bearer(admin.token))
      .send({ fullDayLowerMin: 450 });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('half_day_upper_must_equal_full_day_lower');
  });

  it('updates month-close schedule fields', async () => {
    const { admin } = await seed();
    const res = await request(app)
      .patch('/v1/admin/payroll/policy')
      .set(bearer(admin.token))
      .send({
        approvalReminderDays: [2, 3, 4],
        approvalReminderTime: '01:15',
        payrollSheetSendDay: 6,
        payrollSheetSendTime: '02:30',
        timezone: 'Asia/Kolkata',
      });
    expect(res.status).toBe(200);
    expect(res.body.approvalReminderDays).toEqual([2, 3, 4]);
    expect(res.body.approvalReminderTime).toBe('01:15');
    expect(res.body.payrollSheetSendDay).toBe(6);
    expect(res.body.payrollSheetSendTime).toBe('02:30');
    expect(res.body.timezone).toBe('Asia/Kolkata');
  });
});

describe('GET /v1/admin/payroll/monthly.csv', () => {
  it('returns text/csv with the expected header line', async () => {
    const { admin } = await seed();
    const res = await request(app)
      .get('/v1/admin/payroll/monthly.csv?month=2026-05&tz=UTC')
      .set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('grind-payroll-2026-05.csv');
    const firstLine = res.text.split('\n')[0]!;
    expect(firstLine).toContain('Name');
    expect(firstLine).toContain('Total hours');
  });

  it('CSV last line is TOTAL', async () => {
    const { admin } = await seed();
    const res = await request(app)
      .get('/v1/admin/payroll/monthly.csv?month=2026-05&tz=UTC')
      .set(bearer(admin.token));
    expect(res.status).toBe(200);
    const lines = res.text.trim().split('\n');
    expect(lines[lines.length - 1]).toContain('TOTAL');
  });

  it('rejects MEMBER for CSV too', async () => {
    const { member } = await seed();
    const res = await request(app)
      .get('/v1/admin/payroll/monthly.csv?month=2026-05')
      .set(bearer(member.token));
    expect(res.status).toBe(403);
  });
});
