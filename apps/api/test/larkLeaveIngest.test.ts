import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { prisma } from '@grind/db';
import { NINE_TO_SIX } from '@grind/types';
import { seedUser } from './helpers';
import { ingestLarkLeaveOnce, loadBalance } from '../src/leave';

/**
 * The mirror, end to end against a real database.
 *
 * Lark is faked at the HTTP boundary rather than at our own seam, so the
 * instance shapes here are the ones production actually returns — including the
 * exclusive `end` that made a one-day leave cost two.
 */

const APPROVAL_CODE = 'TEST-LEAVE-CODE';
const IST = -330;
const OPEN_ID = 'ou_test_openid_0001';

/** An IST wall-clock instant, as Lark stores it (UTC ISO). */
function ist(y: number, m: number, d: number, hour = 0): string {
  return new Date(Date.UTC(y, m - 1, d, hour) + IST * 60_000).toISOString().replace('.000Z', 'Z');
}

function leaveForm(v: {
  start: string; end: string; interval: string; name: string; reason: string;
}) {
  return JSON.stringify([
    { id: 'widgetLeaveGroupV2', name: 'Leave component', type: 'leaveGroupV2', value: { ...v, unit: 'DAY', timezoneOffset: IST } },
  ]);
}

interface FakeInstance {
  status: string;
  open_id: string;
  form: string;
}

function installLarkFake(instances: Record<string, FakeInstance>) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/auth/v3/tenant_access_token')) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 't', expire: 7200 }));
    }
    if (url.includes('/approval/v4/instances?')) {
      return new Response(JSON.stringify({
        code: 0,
        data: { instance_code_list: Object.keys(instances), has_more: false },
      }));
    }
    const m = url.match(/\/approval\/v4\/instances\/([^?]+)/);
    if (m) {
      const found = instances[decodeURIComponent(m[1]!)];
      if (!found) return new Response(JSON.stringify({ code: 1390003, msg: 'not found' }));
      return new Response(JSON.stringify({ code: 0, data: found }));
    }
    return new Response(JSON.stringify({ code: 1, msg: `unexpected ${url}` }));
  }));
}

async function seedLinkedUser() {
  const u = await seedUser({ role: 'MEMBER' });
  await prisma.workspace.update({ where: { id: u.workspaceId }, data: { timezone: 'Asia/Kolkata' } });
  await prisma.user.update({
    where: { id: u.userId },
    data: { joinedOn: new Date('2026-01-01T00:00:00Z') },
  });
  await prisma.larkIdentity.create({ data: { userId: u.userId, openId: OPEN_ID } });

  const shift = await prisma.shift.create({
    data: { workspaceId: u.workspaceId, name: 'Day', schedule: NINE_TO_SIX as object },
  });
  await prisma.shiftAssignment.create({
    data: {
      userId: u.userId, shiftId: shift.id,
      effectiveFrom: new Date('2020-01-01T00:00:00Z'), effectiveTo: null,
      shiftNameSnapshot: 'Day', scheduleSnapshot: NINE_TO_SIX as object,
    },
  });
  return u;
}

beforeEach(() => {
  process.env.LARK_LEAVE_APPROVAL_CODE = APPROVAL_CODE;
  process.env.LARK_APP_ID = 'cli_test';
  process.env.LARK_APP_SECRET = 'secret';
  process.env.LARK_TOKEN_KEY = 'k'.repeat(32);
  process.env.LARK_LEAVE_TZ_OFFSET_MIN = String(IST);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.LARK_LEAVE_APPROVAL_CODE;
});

describe('mirroring Lark leave into the ledger', () => {
  it('charges a one-day leave exactly one day, not two', async () => {
    const u = await seedLinkedUser();
    // 2026-08-17 is a Monday. Lark stores it 00:00 -> next 00:00.
    installLarkFake({
      'INST-1': {
        status: 'APPROVED', open_id: OPEN_ID,
        form: leaveForm({
          start: ist(2026, 8, 17), end: ist(2026, 8, 18),
          interval: '1', name: 'Casual Leave', reason: 'family',
        }),
      },
    });

    const result = await ingestLarkLeaveOnce({ now: Date.parse('2026-08-20T00:00:00Z') });
    expect(result.linked).toBe(1);

    const row = await prisma.leaveRequest.findUnique({ where: { larkInstanceCode: 'INST-1' } });
    expect(row?.startDate.toISOString().slice(0, 10)).toBe('2026-08-17');
    // The exclusive end must not stretch this onto the 18th.
    expect(row?.endDate.toISOString().slice(0, 10)).toBe('2026-08-17');
    expect(row?.chargedDays).toBe(1);

    const balance = await loadBalance(u.userId);
    expect(balance.consumedDays).toBe(1);
  });

  it('charges a half day 0.5 and records which half', async () => {
    const u = await seedLinkedUser();
    installLarkFake({
      'INST-2': {
        status: 'APPROVED', open_id: OPEN_ID,
        form: leaveForm({
          start: ist(2026, 8, 17, 12), end: ist(2026, 8, 18),
          interval: '0.5', name: 'Half Day', reason: 'exam',
        }),
      },
    });

    await ingestLarkLeaveOnce({ now: Date.parse('2026-08-20T00:00:00Z') });

    const row = await prisma.leaveRequest.findUnique({ where: { larkInstanceCode: 'INST-2' } });
    expect(row?.portion).toBe('SECOND_HALF');
    expect(row?.chargedDays).toBe(0.5);
    expect((await loadBalance(u.userId)).consumedDays).toBe(0.5);
  });

  it('prices with OUR calendar, so a holiday inside the range is free', async () => {
    const u = await seedLinkedUser();
    await prisma.companyHoliday.create({
      data: { workspaceId: u.workspaceId, date: new Date('2026-08-19T00:00:00Z'), name: 'Holi' },
    });
    // Mon 17 -> Thu 20 inclusive is four working days, one of them Holi.
    installLarkFake({
      'INST-3': {
        status: 'APPROVED', open_id: OPEN_ID,
        form: leaveForm({
          start: ist(2026, 8, 17), end: ist(2026, 8, 21),
          interval: '4', name: 'Casual Leave', reason: 'trip',
        }),
      },
    });

    await ingestLarkLeaveOnce({ now: Date.parse('2026-08-25T00:00:00Z') });

    const row = await prisma.leaveRequest.findUnique({ where: { larkInstanceCode: 'INST-3' } });
    // Lark says 4; the holiday means the balance should only lose 3.
    expect(row?.chargedDays).toBe(3);
    expect((await loadBalance(u.userId)).consumedDays).toBe(3);
  });

  it('does not double-charge when the same instance is swept twice', async () => {
    const u = await seedLinkedUser();
    installLarkFake({
      'INST-4': {
        status: 'APPROVED', open_id: OPEN_ID,
        form: leaveForm({
          start: ist(2026, 8, 17), end: ist(2026, 8, 18),
          interval: '1', name: 'Casual Leave', reason: 'x',
        }),
      },
    });

    await ingestLarkLeaveOnce({ now: Date.parse('2026-08-20T00:00:00Z') });
    await ingestLarkLeaveOnce({ now: Date.parse('2026-08-20T00:00:00Z') });

    expect(await prisma.leaveRequest.count({ where: { userId: u.userId } })).toBe(1);
    expect(
      await prisma.leaveLedgerEntry.count({ where: { userId: u.userId, kind: 'CONSUMPTION' } }),
    ).toBe(1);
    expect((await loadBalance(u.userId)).consumedDays).toBe(1);
  });

  it('gives the days back when Lark later reports it withdrawn', async () => {
    const u = await seedLinkedUser();
    const approved = {
      status: 'APPROVED', open_id: OPEN_ID,
      form: leaveForm({
        start: ist(2026, 8, 17), end: ist(2026, 8, 18),
        interval: '1', name: 'Casual Leave', reason: 'x',
      }),
    };
    installLarkFake({ 'INST-5': approved });
    await ingestLarkLeaveOnce({ now: Date.parse('2026-08-20T00:00:00Z') });
    const afterApproval = await loadBalance(u.userId);
    expect(afterApproval.consumedDays).toBe(1);

    installLarkFake({ 'INST-5': { ...approved, status: 'CANCELED' } });
    await ingestLarkLeaveOnce({ now: Date.parse('2026-08-20T00:00:00Z') });

    const row = await prisma.leaveRequest.findUnique({ where: { larkInstanceCode: 'INST-5' } });
    expect(row?.status).toBe('REJECTED');
    // Given back as a visible reversal, not by deleting the charge.
    const entries = await prisma.leaveLedgerEntry.findMany({
      where: { userId: u.userId }, select: { kind: true, days: true }, orderBy: { createdAt: 'asc' },
    });
    expect(entries.filter((e) => e.kind === 'CONSUMPTION')).toHaveLength(1);
    expect(entries.filter((e) => e.kind === 'ADJUSTMENT')).toHaveLength(1);
    expect((await loadBalance(u.userId)).balanceDays).toBe(afterApproval.balanceDays + 1);
  });

  it('skips somebody with no Lark identity rather than guessing', async () => {
    await seedLinkedUser();
    installLarkFake({
      'INST-6': {
        status: 'APPROVED', open_id: 'ou_someone_else',
        form: leaveForm({
          start: ist(2026, 8, 17), end: ist(2026, 8, 18),
          interval: '1', name: 'Casual Leave', reason: 'x',
        }),
      },
    });

    const result = await ingestLarkLeaveOnce({ now: Date.parse('2026-08-20T00:00:00Z') });
    expect(result.seen).toBe(1);
    expect(result.linked).toBe(0);
    expect(result.unmatched).toBe(1);
    expect(await prisma.leaveRequest.count()).toBe(0);
  });

  it('mirrors a still-pending instance without charging anything', async () => {
    const u = await seedLinkedUser();
    installLarkFake({
      'INST-7': {
        status: 'PENDING', open_id: OPEN_ID,
        form: leaveForm({
          start: ist(2026, 8, 17), end: ist(2026, 8, 18),
          interval: '1', name: 'Casual Leave', reason: 'x',
        }),
      },
    });

    await ingestLarkLeaveOnce({ now: Date.parse('2026-08-20T00:00:00Z') });

    const row = await prisma.leaveRequest.findUnique({ where: { larkInstanceCode: 'INST-7' } });
    expect(row?.status).toBe('PENDING');
    expect((await loadBalance(u.userId)).consumedDays).toBe(0);
  });
});
