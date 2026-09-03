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

const put = (token: string, body: unknown) =>
  request(app).put('/v1/reports/attendance-override').set(bearer(token)).send(body);
const del = (token: string, body: unknown) =>
  request(app).delete('/v1/reports/attendance-override').set(bearer(token)).send(body);

describe('correcting a day by hand', () => {

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

    const res = await del(s.admin.token, {
      userId: s.inTeam.id, date: '2026-08-03', reason: 'the agent came back with the data',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, cleared: true });
    expect((await statusRow(s.admin.token, s.inTeam.email))[3]).toBe('A');
  });

  it('replaces a correction rather than stacking a second one', async () => {
    const s = await seed();
    await assignShift(s.ws.id, s.inTeam.id);
    // Accruing before the day, or it sits below the funding floor and is left
    // alone as leave older than the ledger.
    await prisma.user.update({
      where: { id: s.inTeam.id },
      data: { joinedOn: new Date('2026-01-01T00:00:00Z') },
    });
    await put(s.admin.token, { userId: s.inTeam.id, date: '2026-08-03', code: 'P', reason: 'first' });
    await put(s.admin.token, {
      userId: s.inTeam.id, date: '2026-08-03', code: 'FULL_LEAVE', reason: 'actually on leave',
    });

    const rows = await prisma.attendanceOverride.findMany({ where: { userId: s.inTeam.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ code: 'FULL_LEAVE', reason: 'actually on leave' });
    // No balance behind it, so a full day of leave reads as unpaid. The
    // correction said how much of the day; the ledger said what it cost.
    expect((await statusRow(s.admin.token, s.inTeam.email))[3]).toBe('LWP');
  });

  it('refuses a correction that tries to say whether leave was paid', async () => {
    const s = await seed();
    await assignShift(s.ws.id, s.inTeam.id);
    const res = await put(s.admin.token, {
      userId: s.inTeam.id, date: '2026-08-03', code: 'PL', reason: 'on leave',
    });
    expect(res.status).toBe(400);
  });

  it('keeps every decision, including the one that took a correction back', async () => {
    const s = await seed();
    await assignShift(s.ws.id, s.inTeam.id);
    await put(s.admin.token, { userId: s.inTeam.id, date: '2026-08-03', code: 'P', reason: 'first call' });
    await put(s.admin.token, { userId: s.inTeam.id, date: '2026-08-03', code: 'HALF_LEAVE', reason: 'second call' });
    await del(s.admin.token, { userId: s.inTeam.id, date: '2026-08-03', reason: 'neither, my mistake' });

    const res = await request(app)
      .get(`/v1/reports/attendance-override/history?userId=${s.inTeam.id}&date=2026-08-03`)
      .set(bearer(s.admin.token));
    expect(res.status).toBe(200);
    // Newest first, and the removal is a row of its own rather than a silence.
    expect(res.body.entries.map((e: { code: string | null; reason: string }) => [e.code, e.reason])).toEqual([
      [null, 'neither, my mistake'],
      ['HALF_LEAVE', 'second call'],
      ['P', 'first call'],
    ]);
    expect(res.body.entries[0].setByName).toBe(s.admin.name);
    // The row in force is gone; the record of it is not.
    expect(await prisma.attendanceOverride.count({ where: { userId: s.inTeam.id } })).toBe(0);
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

/**
 * A manager's correction spends the balance, so the days after it move.
 *
 * The case this was written for: one accrual, a half day of leave, a day a
 * manager called a paid half day, and a full day after that. Before the
 * correction counted, the full day had half a balance behind it and read as
 * half paid. After, there is nothing left and it is unpaid outright — which is
 * the only answer consistent with what the manager said the middle day was.
 */
describe('a correction moves the days after it', () => {
  async function statusRow(token: string, email: string) {
    const res = await request(app)
      .get('/v1/reports/month-performance.csv?month=2026-08')
      .set(bearer(token));
    expect(res.status).toBe(200);
    const block = blockFor(res.text, email);
    expect(block).not.toBeNull();
    const status = block!.find((l) => l.startsWith('Status,'));
    expect(status).toBeDefined();
    // Day 1 is the second cell; index by date to keep the assertions readable.
    const cells = status!.split(',');
    return (day: number) => cells[day]?.trim();
  }

  it('re-spends the balance from the day the correction changed', async () => {
    const s = await seed();
    await assignShift(s.ws.id, s.inTeam.id);
    // Accrual starts before the window, or every August day sits below the
    // funding floor and is left alone as leave older than the ledger.
    await prisma.user.update({
      where: { id: s.inTeam.id },
      data: { joinedOn: new Date('2026-01-01T00:00:00Z') },
    });
    await prisma.leavePolicy.create({
      data: { workspaceId: s.ws.id, monthlyAccrualDays: 1, ledgerStartMonth: '2026-08' },
    });
    await prisma.leaveLedgerEntry.create({
      data: {
        workspaceId: s.ws.id,
        userId: s.inTeam.id,
        kind: 'ACCRUAL',
        days: 1,
        effectiveOn: new Date('2026-08-01T00:00:00Z'),
        sourceKey: `accr-${s.inTeam.id}-2026-08`,
      },
    });
    const leave = (start: string, end: string, portion: 'FULL' | 'FIRST_HALF', charged: number) =>
      prisma.leaveRequest.create({
        data: {
          clientUuid: ulid(),
          workspaceId: s.ws.id,
          userId: s.inTeam.id,
          kind: 'PAID',
          startDate: new Date(`${start}T00:00:00Z`),
          endDate: new Date(`${end}T00:00:00Z`),
          portion,
          chargedDays: charged,
          reason: 'test',
          status: 'APPROVED',
        },
      });
    await leave('2026-08-10', '2026-08-10', 'FIRST_HALF', 0.5);
    await leave('2026-08-21', '2026-08-21', 'FULL', 1);

    // The half day spends 0.5, so the full day has 0.5 behind it and splits.
    expect((await statusRow(s.admin.token, s.inTeam.email))(21)).toBe('PL_HD/LWP_HD');

    await prisma.attendanceOverride.create({
      data: {
        workspaceId: s.ws.id,
        userId: s.inTeam.id,
        date: new Date('2026-08-14T00:00:00Z'),
        code: 'PL_HD',
        reason: 'no application submitted',
        computedCode: 'A',
        setById: s.manager.id,
      },
    });

    const after = await statusRow(s.admin.token, s.inTeam.email);
    expect(after(14)).toBe('PL_HD');
    // The correction took the other half, so nothing is left for the 21st.
    expect(after(21)).toBe('LWP');
  });

  it('stops paying for leave on a day a correction calls present', async () => {
    const s = await seed();
    await assignShift(s.ws.id, s.inTeam.id);
    // Accrual starts before the window, or every August day sits below the
    // funding floor and is left alone as leave older than the ledger.
    await prisma.user.update({
      where: { id: s.inTeam.id },
      data: { joinedOn: new Date('2026-01-01T00:00:00Z') },
    });
    await prisma.leavePolicy.create({
      data: { workspaceId: s.ws.id, monthlyAccrualDays: 1, ledgerStartMonth: '2026-08' },
    });
    await prisma.leaveLedgerEntry.create({
      data: {
        workspaceId: s.ws.id,
        userId: s.inTeam.id,
        kind: 'ACCRUAL',
        days: 1,
        effectiveOn: new Date('2026-08-01T00:00:00Z'),
        sourceKey: `accr2-${s.inTeam.id}-2026-08`,
      },
    });
    for (const date of ['2026-08-10', '2026-08-11']) {
      await prisma.leaveRequest.create({
        data: {
          clientUuid: ulid(),
          workspaceId: s.ws.id,
          userId: s.inTeam.id,
          kind: 'PAID',
          startDate: new Date(`${date}T00:00:00Z`),
          endDate: new Date(`${date}T00:00:00Z`),
          portion: 'FULL',
          chargedDays: 1,
          reason: 'test',
          status: 'APPROVED',
        },
      });
    }
    // One day of balance, two full days of leave: the second goes unpaid.
    expect((await statusRow(s.admin.token, s.inTeam.email))(11)).toBe('LWP');

    await prisma.attendanceOverride.create({
      data: {
        workspaceId: s.ws.id,
        userId: s.inTeam.id,
        date: new Date('2026-08-10T00:00:00Z'),
        code: 'P',
        reason: 'he was here',
        computedCode: 'PL',
        setById: s.manager.id,
      },
    });

    // The 10th no longer spends anything, so the 11th gets the whole day.
    const after = await statusRow(s.admin.token, s.inTeam.email);
    expect(after(10)).toBe('P');
    expect(after(11)).toBe('PL');
  });
});

/**
 * The Bhojraj case, both halves of it.
 *
 * A day accrued, a half day of leave from Lark, a manager calling another day
 * half a day of leave, and a full day after that. Before the correction reached
 * the ledger the report said three leave days had been taken while the
 * statement said one and a half, and both numbers were on screen at once.
 */
describe('a correction reaches the balance, not just the labels', () => {
  async function setup() {
    const s = await seed();
    await assignShift(s.ws.id, s.inTeam.id);
    await prisma.user.update({
      where: { id: s.inTeam.id },
      data: { joinedOn: new Date('2026-01-01T00:00:00Z') },
    });
    await prisma.leavePolicy.create({
      data: { workspaceId: s.ws.id, monthlyAccrualDays: 1, ledgerStartMonth: '2026-08' },
    });
    await prisma.leaveLedgerEntry.create({
      data: {
        workspaceId: s.ws.id,
        userId: s.inTeam.id,
        kind: 'ACCRUAL',
        days: 1,
        effectiveOn: new Date('2026-08-01T00:00:00Z'),
        sourceKey: `accr-bh-${s.inTeam.id}`,
      },
    });
    return s;
  }

  /**
   * Net days of leave the ledger says August cost — everything but the accrual.
   *
   * Net, not the sum of the negatives: a correction that hands a day back is a
   * positive entry, and counting only what was taken would miss it entirely.
   */
  const consumedFor = async (userId: string) => {
    const rows = await prisma.leaveLedgerEntry.findMany({
      where: {
        userId,
        kind: { not: 'ACCRUAL' },
        effectiveOn: { gte: new Date('2026-08-01T00:00:00Z') },
      },
    });
    const total = rows.reduce((sum, r) => sum + r.days, 0);
    // `-0` and `0` are different to Object.is, and nobody reading this means
    // them to be.
    return total === 0 ? 0 : -total;
  };

  it('charges a day a manager called leave that nobody had filed', async () => {
    const s = await setup();
    await prisma.leaveRequest.create({
      data: {
        clientUuid: ulid(),
        workspaceId: s.ws.id,
        userId: s.inTeam.id,
        kind: 'PAID',
        startDate: new Date('2026-08-10T00:00:00Z'),
        endDate: new Date('2026-08-10T00:00:00Z'),
        portion: 'FIRST_HALF',
        chargedDays: 0.5,
        reason: 'headache',
        status: 'APPROVED',
      },
    });
    await prisma.leaveLedgerEntry.create({
      data: {
        workspaceId: s.ws.id,
        userId: s.inTeam.id,
        kind: 'CONSUMPTION',
        days: -0.5,
        effectiveOn: new Date('2026-08-10T00:00:00Z'),
        sourceKey: `leave-bh-${s.inTeam.id}`,
      },
    });
    expect(await consumedFor(s.inTeam.id)).toBe(0.5);

    await put(s.admin.token, {
      userId: s.inTeam.id, date: '2026-08-14', code: 'HALF_LEAVE', reason: 'no application',
    });

    // Half a day more, and the statement now agrees with the grid about how
    // many days of leave August held.
    expect(await consumedFor(s.inTeam.id)).toBe(1);
    const entry = await prisma.leaveLedgerEntry.findUnique({
      where: { sourceKey: `override:${s.inTeam.id}:2026-08-14` },
    });
    expect(entry).toMatchObject({ kind: 'ADJUSTMENT', days: -0.5 });
  });

  it('hands back what Lark took when a correction says the day was worked', async () => {
    const s = await setup();
    await prisma.leaveRequest.create({
      data: {
        clientUuid: ulid(),
        workspaceId: s.ws.id,
        userId: s.inTeam.id,
        kind: 'PAID',
        startDate: new Date('2026-08-10T00:00:00Z'),
        endDate: new Date('2026-08-10T00:00:00Z'),
        portion: 'FULL',
        chargedDays: 1,
        reason: 'casual',
        status: 'APPROVED',
      },
    });
    await prisma.leaveLedgerEntry.create({
      data: {
        workspaceId: s.ws.id,
        userId: s.inTeam.id,
        kind: 'CONSUMPTION',
        days: -1,
        effectiveOn: new Date('2026-08-10T00:00:00Z'),
        sourceKey: `leave-bh2-${s.inTeam.id}`,
      },
    });

    await put(s.admin.token, {
      userId: s.inTeam.id, date: '2026-08-10', code: 'P', reason: 'he was here all day',
    });
    const entry = await prisma.leaveLedgerEntry.findUnique({
      where: { sourceKey: `override:${s.inTeam.id}:2026-08-10` },
    });
    expect(entry).toMatchObject({ days: 1 });
    expect(await consumedFor(s.inTeam.id)).toBe(0);
  });

  it('writes nothing when the correction agrees with the leave already on file', async () => {
    const s = await setup();
    await prisma.leaveRequest.create({
      data: {
        clientUuid: ulid(),
        workspaceId: s.ws.id,
        userId: s.inTeam.id,
        kind: 'PAID',
        startDate: new Date('2026-08-10T00:00:00Z'),
        endDate: new Date('2026-08-10T00:00:00Z'),
        portion: 'FULL',
        chargedDays: 1,
        reason: 'casual',
        status: 'APPROVED',
      },
    });
    await put(s.admin.token, {
      userId: s.inTeam.id, date: '2026-08-10', code: 'FULL_LEAVE', reason: 'confirming it',
    });
    // Same answer, so there is no difference to record.
    expect(await prisma.leaveLedgerEntry.findUnique({
      where: { sourceKey: `override:${s.inTeam.id}:2026-08-10` },
    })).toBeNull();
  });

  it('takes the entry back when the correction is removed', async () => {
    const s = await setup();
    await put(s.admin.token, {
      userId: s.inTeam.id, date: '2026-08-14', code: 'FULL_LEAVE', reason: 'away',
    });
    expect(await consumedFor(s.inTeam.id)).toBe(1);

    await del(s.admin.token, { userId: s.inTeam.id, date: '2026-08-14', reason: 'my mistake' });
    expect(await consumedFor(s.inTeam.id)).toBe(0);
    expect(await prisma.leaveLedgerEntry.findUnique({
      where: { sourceKey: `override:${s.inTeam.id}:2026-08-14` },
    })).toBeNull();
  });

  it('costs nothing on a day off, whatever a correction says', async () => {
    const s = await setup();
    // 2026-08-23 is a Sunday, and the seeded shift has Sunday off.
    await put(s.admin.token, {
      userId: s.inTeam.id, date: '2026-08-23', code: 'FULL_LEAVE', reason: 'called in',
    });
    expect(await prisma.leaveLedgerEntry.findUnique({
      where: { sourceKey: `override:${s.inTeam.id}:2026-08-23` },
    })).toBeNull();
  });
});
