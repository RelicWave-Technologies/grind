import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { ulid } from 'ulid';
import { buildApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';

/**
 * The month performance export as an HTTP surface: does it come back as a file
 * with the right type, does the punch record reach the grid, and — the part
 * that matters most — does a manager get their team and nobody else.
 */

const app = buildApp();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** A Monday-to-Saturday shift, so the seeded days are expected working days —
 *  without one the Working Calendar says NO_SHIFT and the report prints `--`. */
const SIX_DAY_SCHEDULE = {
  mon: { start: '09:00', end: '18:00' },
  tue: { start: '09:00', end: '18:00' },
  wed: { start: '09:00', end: '18:00' },
  thu: { start: '09:00', end: '18:00' },
  fri: { start: '09:00', end: '18:00' },
  sat: { start: '09:00', end: '18:00' },
  sun: null,
};

async function assignShift(workspaceId: string, userId: string) {
  const shift = await prisma.shift.create({
    data: { workspaceId, name: 'General', schedule: SIX_DAY_SCHEDULE },
  });
  await prisma.shiftAssignment.create({
    data: {
      userId,
      shiftId: shift.id,
      effectiveFrom: new Date('2020-01-01T00:00:00Z'),
      shiftNameSnapshot: shift.name,
      scheduleSnapshot: SIX_DAY_SCHEDULE,
    },
  });
  return shift;
}

/** Seed a closed AUTO work entry, which is what the report counts as tracked. */
async function seedEntry(userId: string, startedAt: Date, endedAt: Date) {
  return prisma.timeEntry.create({
    data: {
      id: ulid(),
      clientUuid: ulid(),
      userId,
      source: 'AUTO',
      startedAt,
      endedAt,
      agentVersion: '0.0.0',
      platform: 'test',
      segments: { create: [{ id: ulid(), kind: 'WORK', startedAt, endedAt }] },
    },
  });
}

let counter = 0;
async function seed() {
  counter += 1;
  const stamp = `${Date.now()}-${counter}-mperf`;
  const ws = await prisma.workspace.create({
    data: { name: `EMIAC ${stamp}`, timezone: 'Asia/Kolkata' },
  });
  const teamA = await prisma.team.create({ data: { workspaceId: ws.id, name: 'Technical' } });
  const teamB = await prisma.team.create({ data: { workspaceId: ws.id, name: 'Media Buying' } });

  const mk = (label: string, role: 'ADMIN' | 'MANAGER' | 'MEMBER', teamId: string | null) =>
    prisma.user.create({
      data: {
        workspaceId: ws.id,
        email: `${label}-${stamp}@test.local`,
        name: label,
        role,
        teamId,
        passwordHash: 'x'.repeat(60),
      },
    });

  const admin = await mk('admin', 'ADMIN', null);
  const manager = await mk('manager', 'MANAGER', teamA.id);
  const inTeam = await mk('in-team', 'MEMBER', teamA.id);
  const outsider = await mk('outsider', 'MEMBER', teamB.id);
  await prisma.teamManager.create({
    data: { workspaceId: ws.id, teamId: teamA.id, userId: manager.id },
  });

  const token = (u: { id: string; role: 'ADMIN' | 'MANAGER' | 'MEMBER' }) =>
    signAccessToken({ sub: u.id, ws: ws.id, role: u.role });

  return {
    ws,
    admin: { ...admin, token: token(admin) },
    manager: { ...manager, token: token(manager) },
    inTeam: { ...inTeam, token: token(inTeam) },
    outsider: { ...outsider, token: token(outsider) },
  };
}

async function seedPunch(opts: {
  workspaceId: string;
  userId: string;
  date: string;
  punchIn: string | null;
  punchOut: string | null;
}) {
  return prisma.attendancePunch.create({
    data: {
      workspaceId: opts.workspaceId,
      userId: opts.userId,
      date: new Date(`${opts.date}T00:00:00Z`),
      punchInAt: opts.punchIn ? new Date(`1970-01-01T${opts.punchIn}Z`) : null,
      punchOutAt: opts.punchOut ? new Date(`1970-01-01T${opts.punchOut}Z`) : null,
      note: 'test',
    },
  });
}

/** The ten lines for one person, found by their email in the caption row. */
function blockFor(csv: string, email: string): string[] | null {
  const lines = csv.split('\n');
  const header = lines.findIndex((l) => l.startsWith('Email,') && l.includes(email));
  return header === -1 ? null : lines.slice(header - 1, header + 7);
}

describe('GET /v1/reports/month-performance.csv', () => {
  it('returns a CSV attachment laid out as the monthly grid', async () => {
    const s = await seed();
    const res = await request(app)
      .get('/v1/reports/month-performance.csv?month=2026-08')
      .set(bearer(s.admin.token));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('month-performance-2026-08.csv');

    const block = blockFor(res.text, s.inTeam.email);
    expect(block).not.toBeNull();
    expect(block![0]).toContain('Report Month,August-2026');
    expect(block![2]!.split(',').slice(1)).toHaveLength(31);
    expect(block!.slice(4).map((l) => l.split(',')[0])).toEqual([
      'Office In', 'Office Out', 'Total Working Hours', 'Status',
    ]);
  });

  it('prints the punch record, and a dash for a day with no punch', async () => {
    const s = await seed();
    await seedPunch({
      workspaceId: s.ws.id,
      userId: s.inTeam.id,
      date: '2026-08-03',
      punchIn: '09:27:00',
      punchOut: '18:27:00',
    });
    await seedPunch({
      workspaceId: s.ws.id,
      userId: s.inTeam.id,
      date: '2026-08-04',
      punchIn: '10:14:00',
      punchOut: null,
    });

    const res = await request(app)
      .get('/v1/reports/month-performance.csv?month=2026-08')
      .set(bearer(s.admin.token));
    const block = blockFor(res.text, s.inTeam.email)!;
    const inRow = block[4]!.split(',');
    const outRow = block[5]!.split(',');

    // Column 1 is the label, so day N is at index N.
    expect(inRow[3]).toBe('09:27');
    expect(outRow[3]).toBe('18:27');
    expect(inRow[4]).toBe('10:14');
    expect(outRow[4]).toBe('--:--');
    expect(inRow[5]).toBe('--:--');
  });

  it('takes WORK from tracked time, not from the punch span', async () => {
    const s = await seed();
    // Badged 09:28-22:11 — nearly thirteen hours at the door — but only nine
    // hours tracked. The hours row has to report the nine.
    await seedPunch({
      workspaceId: s.ws.id,
      userId: s.inTeam.id,
      date: '2026-08-03',
      punchIn: '09:28:00',
      punchOut: '22:11:00',
    });
    // 09:00-18:00 IST on 2026-08-03 = 03:30-12:30 UTC.
    await seedEntry(
      s.inTeam.id,
      new Date('2026-08-03T03:30:00Z'),
      new Date('2026-08-03T12:30:00Z'),
    );
    const res = await request(app)
      .get('/v1/reports/month-performance.csv?month=2026-08')
      .set(bearer(s.admin.token));
    const block = blockFor(res.text, s.inTeam.email)!;
    expect(block[4]!.split(',')[3]).toBe('09:28'); // office in, still the badge
    expect(block[6]!.split(',')[3]).toBe('09:00'); // hours, from tracked time
    expect(block[7]!.split(',')[3]).toBe('P');
    expect(block[1]).toContain('Total Hours,09:00');
  });

  it('marks a badged day absent only when nothing at all was tracked', async () => {
    const s = await seed();
    await assignShift(s.ws.id, s.inTeam.id);
    await seedPunch({
      workspaceId: s.ws.id,
      userId: s.inTeam.id,
      date: '2026-08-04',
      punchIn: '09:55:00',
      punchOut: '18:12:00',
    });
    const res = await request(app)
      .get('/v1/reports/month-performance.csv?month=2026-08')
      .set(bearer(s.admin.token));
    const block = blockFor(res.text, s.inTeam.email)!;
    // Badge times are printed; with nothing tracked the day is still absent.
    expect(block[4]!.split(',')[4]).toBe('09:55');
    expect(block[5]!.split(',')[4]).toBe('18:12');
    expect(block[6]!.split(',')[4]).toBe('00:00');
    expect(block[7]!.split(',')[4]).toBe('A');
  });

  it('gives a manager their team and nobody else', async () => {
    const s = await seed();
    const res = await request(app)
      .get('/v1/reports/month-performance.csv?month=2026-08')
      .set(bearer(s.manager.token));

    expect(res.status).toBe(200);
    expect(res.text).toContain(s.inTeam.email);
    expect(res.text).not.toContain(s.outsider.email);
  });

  it('refuses a member, who has no capability to read other people', async () => {
    const s = await seed();
    const res = await request(app)
      .get('/v1/reports/month-performance.csv?month=2026-08')
      .set(bearer(s.inTeam.token));
    expect(res.status).toBe(403);
  });

  it('rejects a month it cannot parse rather than guessing one', async () => {
    const s = await seed();
    const res = await request(app)
      .get('/v1/reports/month-performance.csv?month=August')
      .set(bearer(s.admin.token));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_month');
  });
});

describe('GET /v1/reports/month-performance.xlsx', () => {
  it('returns a real workbook, not a CSV with a different extension', async () => {
    const s = await seed();
    const res = await request(app)
      .get('/v1/reports/month-performance.xlsx?month=2026-08')
      .set(bearer(s.admin.token))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain(XLSX_MIME);
    expect(res.headers['content-disposition']).toContain('month-performance-2026-08.xlsx');
    // An .xlsx is a zip: it starts with the local file header signature.
    const body = res.body as Buffer;
    expect(body.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(body.length).toBeGreaterThan(1000);
  });
});

describe('correcting a day by hand', () => {
  const put = (token: string, body: unknown) =>
    request(app).put('/v1/reports/attendance-override').set(bearer(token)).send(body);
  const del = (token: string, body: unknown) =>
    request(app).delete('/v1/reports/attendance-override').set(bearer(token)).send(body);

  /** The Status row for one person, as the CSV renders it. */
  async function statusRow(token: string, email: string) {
    const res = await request(app)
      .get('/v1/reports/month-performance.csv?month=2026-08')
      .set(bearer(token));
    return blockFor(res.text, email)![7]!.split(',');
  }

  it('turns an absent day present, and the export follows', async () => {
    const s = await seed();
    await assignShift(s.ws.id, s.inTeam.id);

    // 2026-08-03 is a Monday with nothing tracked: absent.
    expect((await statusRow(s.admin.token, s.inTeam.email))[3]).toBe('A');

    const res = await put(s.admin.token, {
      userId: s.inTeam.id, date: '2026-08-03', code: 'P', reason: 'Agent was down; present all day',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, code: 'P', computedCode: 'A' });

    expect((await statusRow(s.admin.token, s.inTeam.email))[3]).toBe('P');
  });

  it('clears back to whatever the report computes', async () => {
    const s = await seed();
    await assignShift(s.ws.id, s.inTeam.id);
    await put(s.admin.token, { userId: s.inTeam.id, date: '2026-08-03', code: 'P', reason: 'x' });
    expect((await statusRow(s.admin.token, s.inTeam.email))[3]).toBe('P');

    const res = await del(s.admin.token, { userId: s.inTeam.id, date: '2026-08-03' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, cleared: true });
    expect((await statusRow(s.admin.token, s.inTeam.email))[3]).toBe('A');
  });

  it('replaces a correction rather than stacking a second one', async () => {
    const s = await seed();
    await assignShift(s.ws.id, s.inTeam.id);
    await put(s.admin.token, { userId: s.inTeam.id, date: '2026-08-03', code: 'P', reason: 'first' });
    await put(s.admin.token, { userId: s.inTeam.id, date: '2026-08-03', code: 'PL', reason: 'actually on leave' });

    const rows = await prisma.attendanceOverride.findMany({ where: { userId: s.inTeam.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ code: 'PL', reason: 'actually on leave' });
    expect((await statusRow(s.admin.token, s.inTeam.email))[3]).toBe('PL');
  });

  it('records who made the call and why', async () => {
    const s = await seed();
    await assignShift(s.ws.id, s.inTeam.id);
    await put(s.admin.token, {
      userId: s.inTeam.id, date: '2026-08-03', code: 'P', reason: 'Badged in; agent crashed',
    });
    const row = await prisma.attendanceOverride.findFirst({ where: { userId: s.inTeam.id } });
    expect(row).toMatchObject({ setById: s.admin.id, reason: 'Badged in; agent crashed', computedCode: 'A' });
    expect(row!.setAt).toBeInstanceOf(Date);
  });

  it('refuses a reason-less correction', async () => {
    const s = await seed();
    const res = await put(s.admin.token, { userId: s.inTeam.id, date: '2026-08-03', code: 'P', reason: '  ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('refuses a code a person may not set by hand', async () => {
    const s = await seed();
    const res = await put(s.admin.token, { userId: s.inTeam.id, date: '2026-08-03', code: 'HL', reason: 'x' });
    expect(res.status).toBe(400);
  });

  it('will not let a manager correct somebody outside their team', async () => {
    const s = await seed();
    const res = await put(s.manager.token, {
      userId: s.outsider.id, date: '2026-08-03', code: 'P', reason: 'not mine to correct',
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('out_of_scope');
    expect(await prisma.attendanceOverride.count({ where: { userId: s.outsider.id } })).toBe(0);
  });

  it('lets a manager correct their own team', async () => {
    const s = await seed();
    await assignShift(s.ws.id, s.inTeam.id);
    const res = await put(s.manager.token, {
      userId: s.inTeam.id, date: '2026-08-03', code: 'P', reason: 'mine to correct',
    });
    expect(res.status).toBe(200);
  });

  it('refuses a member entirely', async () => {
    const s = await seed();
    const res = await put(s.inTeam.token, {
      userId: s.inTeam.id, date: '2026-08-03', code: 'P', reason: 'self-serve',
    });
    expect(res.status).toBe(403);
  });
});
