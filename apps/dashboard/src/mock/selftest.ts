/**
 * Drives every mocked route through the real dispatcher for each role (and
 * the empty workspace), checks status codes and schemas, and lists any route
 * that no case touched. Mutations run against a snapshot that is restored
 * afterwards, so the session's data is left as it was.
 *
 * Browser: `__timoMock.selfTest()` in the console, or the panel button.
 */
import type { Role } from '@grind/types';
import { addDays, monthOf, prevWeekday, shiftMonth, todayKey } from './clock';
import { exportDb, getDb, importDb } from './db';
import { handle, type MockResult } from './dispatch';
import { listRoutes } from './http';
import { getSettings, updateSettings, type MockSettings } from './settings';

interface Case {
  method: string;
  url: string;
  body?: unknown;
  /** Roles that may call it; others are skipped. */
  roles?: Role[];
  expect?: number;
}

export interface SelfTestProblem {
  role: Role;
  empty: boolean;
  method: string;
  url: string;
  status: number;
  detail: string;
}

export interface SelfTestReport {
  calls: number;
  problems: SelfTestProblem[];
  uncovered: string[];
  unmatched: string[];
}

const MGR: Role[] = ['ADMIN', 'MANAGER'];
const ADM: Role[] = ['ADMIN'];

function readCases(): Case[] {
  const today = todayKey();
  const week = addDays(today, -6);
  const month = monthOf(today);
  const yday = prevWeekday(addDays(today, -1));
  const q = (o: Record<string, string>) => new URLSearchParams(o).toString();
  return [
    { method: 'GET', url: '/v1/auth/me' },
    { method: 'POST', url: '/v1/auth/refresh-cookie' },
    { method: 'GET', url: '/v1/profile/me' },
    { method: 'GET', url: '/v1/workspace/users' },
    { method: 'GET', url: '/v1/lark/my-tasks' },
    { method: 'GET', url: `/v1/insights/day?${q({ date: today, tz: 'Asia/Kolkata' })}` },
    { method: 'GET', url: `/v1/insights/day?${q({ date: yday, tz: 'Asia/Kolkata', gapScope: 'calendar-day' })}` },
    { method: 'GET', url: `/v1/insights/day?${q({ date: yday, tz: 'Asia/Kolkata', userId: 'usr_vikram' })}`, roles: MGR },
    { method: 'GET', url: '/v1/time-requests?role=mine&status=PENDING' },
    { method: 'GET', url: `/v1/time-requests?${q({ role: 'mine', from: week, to: today, tz: 'Asia/Kolkata' })}` },
    { method: 'GET', url: `/v1/reports/me?${q({ from: week, to: today, tz: 'Asia/Kolkata' })}` },
    { method: 'GET', url: `/v1/reports/me/day-apps?${q({ date: yday, tz: 'Asia/Kolkata' })}` },
    { method: 'GET', url: `/v1/reports/me/day-screenshots?${q({ date: yday, tz: 'Asia/Kolkata' })}` },
    { method: 'GET', url: `/v1/reports/team/summary?${q({ from: addDays(today, -30), to: today, tz: 'Asia/Kolkata' })}`, roles: MGR },
    { method: 'GET', url: `/v1/reports/team/summary?${q({ from: week, to: today, tz: 'Asia/Kolkata', teamId: 'team_design' })}`, roles: ADM },
    { method: 'GET', url: `/v1/reports/month-summary?${q({ month: today.slice(0, 7) })}`, roles: MGR },
    { method: 'GET', url: `/v1/reports/team?${q({ from: week, to: today, tz: 'Asia/Kolkata' })}`, roles: MGR },
    { method: 'GET', url: `/v1/reports/team/member?${q({ userId: 'usr_vikram', from: week, to: today, tz: 'Asia/Kolkata' })}`, roles: MGR },
    { method: 'GET', url: `/v1/reports/team/member/day-apps?${q({ userId: 'usr_vikram', date: yday, tz: 'Asia/Kolkata' })}`, roles: MGR },
    { method: 'GET', url: `/v1/reports/team/member/day-screenshots?${q({ userId: 'usr_vikram', date: yday, tz: 'Asia/Kolkata' })}`, roles: MGR },
    { method: 'GET', url: `/v1/reports/attendance-override/history?${q({ userId: 'usr_vikram', date: prevWeekday(addDays(today, -3)) })}`, roles: MGR },
    { method: 'GET', url: `/v1/reports/month-performance.csv?month=${month}`, roles: MGR },
    { method: 'GET', url: `/v1/reports/month-performance.xlsx?month=${month}`, roles: MGR },
    { method: 'GET', url: `/v1/admin/overview?tz=Asia%2FKolkata`, roles: MGR },
    { method: 'GET', url: `/v1/admin/manual-time-requests?${q({ status: 'ALL', from: week, to: today, tz: 'Asia/Kolkata' })}`, roles: MGR },
    { method: 'GET', url: '/v1/admin/flags?status=OPEN', roles: MGR },
    { method: 'GET', url: '/v1/admin/flags?status=RESOLVED', roles: MGR },
    { method: 'GET', url: '/v1/admin/flags/groups?status=OPEN', roles: MGR },
    { method: 'GET', url: '/v1/admin/flags/groups?status=RESOLVED', roles: MGR },
    { method: 'GET', url: `/v1/admin/timesheets?${q({ from: addDays(today, -13), to: today, tz: 'Asia/Kolkata' })}`, roles: MGR },
    { method: 'GET', url: `/v1/admin/timesheets.csv?${q({ from: week, to: today, tz: 'Asia/Kolkata' })}`, roles: MGR },
    { method: 'GET', url: '/v1/admin/users', roles: MGR },
    { method: 'GET', url: '/v1/admin/users?includeDeactivated=true', roles: ADM },
    { method: 'GET', url: '/v1/admin/users/usr_rhea/deletion-plan', roles: ADM },
    { method: 'GET', url: '/v1/admin/teams', roles: MGR },
    { method: 'GET', url: '/v1/admin/shifts', roles: MGR },
    { method: 'GET', url: '/v1/admin/team-member-settings', roles: MGR },
    { method: 'GET', url: '/v1/admin/workspace-policy', roles: MGR },
    { method: 'GET', url: '/v1/admin/monitoring-settings-audits?limit=20', roles: ADM },
    { method: 'GET', url: '/v1/admin/payroll/policy', roles: ADM },
    { method: 'GET', url: `/v1/admin/payroll/monthly?month=${month}`, roles: ADM },
    { method: 'GET', url: `/v1/admin/payroll/monthly?month=${shiftMonth(month, -1)}`, roles: ADM },
    { method: 'GET', url: `/v1/admin/payroll/monthly.csv?month=${month}`, roles: ADM },
    { method: 'GET', url: '/v1/admin/api-tokens', roles: ADM },
    { method: 'GET', url: `/v1/leave/calendar?from=${month}-01&to=${addDays(`${shiftMonth(month, 1)}-01`, -1)}` },
    { method: 'GET', url: '/v1/leave/me/balance' },
    { method: 'GET', url: '/v1/leave/policy' },
    { method: 'GET', url: '/v1/leave/me/requests' },
    { method: 'GET', url: `/v1/admin/leave/balances?asOf=${today}` },
    { method: 'GET', url: '/v1/downloads/agent/mac' },
  ];
}

/** Ordered writes; ids are looked up from the live store as they run. */
function writeCases(): Array<Case & { as: Role; pick?: () => string }> {
  const db = getDb(todayKey());
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const pendingOf = (userId: string) => db.requests.find((r) => r.userId === userId && r.status === 'PENDING')?.id ?? 'missing';
  // Whatever is still pending in Engineering (the manager persona's team) —
  // the session may already have decided some of the seeded ones.
  const engIds = new Set(db.users.filter((u) => u.teamId === 'team_eng' && u.id !== 'usr_arjun').map((u) => u.id));
  const teamPending = db.requests.filter((r) => engIds.has(r.userId) && r.status === 'PENDING').map((r) => r.id);
  const openFlag = db.flags.find((f) => engIds.has(f.userId) && f.status === 'OPEN')?.id ?? 'missing';
  const groupFlags = db.flags.filter((f) => engIds.has(f.userId) && f.status === 'OPEN' && f.id !== openFlag).slice(0, 2).map((f) => f.id);
  const yday = prevWeekday(addDays(todayKey(), -1));
  const ydayEntry = `te_ananya_${yday.replace(/-/g, '')}_0`;
  const manual = db.manualEntries.find((m) => m.userId === 'usr_ananya')?.id ?? 'missing';
  const absent = prevWeekday(addDays(todayKey(), -3));
  const slot = { requestedStart: iso(now - 26 * 3_600_000), requestedEnd: iso(now - 25 * 3_600_000) };
  return [
    { as: 'MEMBER', method: 'POST', url: '/v1/time-requests', body: { clientUuid: 'selftest-1', ...slot, larkTaskGuid: null, taskSummary: null, reason: 'Self-test request' }, expect: 201 },
    { as: 'MEMBER', method: 'PATCH', url: `/v1/time-requests/${pendingOf('usr_ananya')}`, body: { reason: 'Edited by self-test' } },
    { as: 'MEMBER', method: 'POST', url: `/v1/time-requests/${pendingOf('usr_ananya')}/cancel` },
    { as: 'MEMBER', method: 'PATCH', url: `/v1/time-entries/${ydayEntry}`, body: { larkTaskGuid: 'tsk_d_tokens', notes: 'Self-test note' } },
    { as: 'MEMBER', method: 'DELETE', url: `/v1/time-entries/${manual}` },
    { as: 'ADMIN', method: 'POST', url: '/v1/time-requests', body: { clientUuid: 'selftest-2', userId: 'usr_rhea', ...slot, larkTaskGuid: 'tsk_d_checkout', taskSummary: null, reason: 'Added for Rhea' }, expect: 201 },
    { as: 'MANAGER', method: 'POST', url: `/v1/admin/manual-time-requests/${teamPending[0] ?? 'missing'}/decide`, body: { action: 'approve' } },
    { as: 'MANAGER', method: 'POST', url: `/v1/admin/manual-time-requests/${teamPending[1] ?? 'missing'}/decide`, body: { action: 'reject' } },
    { as: 'MANAGER', method: 'POST', url: `/v1/admin/flags/${openFlag}/resolve`, body: { resolution: 'DISMISSED', note: 'Typing drill' } },
    { as: 'MANAGER', method: 'POST', url: '/v1/admin/flags/resolve-many', body: { flagIds: groupFlags, resolution: 'CONFIRMED' } },
    { as: 'MANAGER', method: 'PUT', url: '/v1/reports/attendance-override', body: { userId: 'usr_priya', date: absent, code: 'HALF_LEAVE', reason: 'Self-test' } },
    { as: 'MANAGER', method: 'DELETE', url: '/v1/reports/attendance-override', body: { userId: 'usr_priya', date: absent, reason: 'Self-test undo' } },
    { as: 'MANAGER', method: 'PATCH', url: '/v1/admin/team-member-settings/usr_priya', body: { screenshotIntervalMin: 2, idleThresholdMin: 10 } },
    { as: 'ADMIN', method: 'POST', url: '/v1/admin/users', body: { email: 'selftest@saffronloop.studio', name: 'Self Test', role: 'MEMBER', activityRoleTitle: 'OTHER' }, expect: 201 },
    { as: 'ADMIN', method: 'PATCH', url: '/v1/admin/users/usr_rohan', body: { shiftId: 'shf_general', birthDate: '1998-10-06' } },
    { as: 'ADMIN', method: 'POST', url: '/v1/admin/users/usr_aditya/deactivate' },
    { as: 'ADMIN', method: 'POST', url: '/v1/admin/users/usr_aditya/reactivate' },
    { as: 'ADMIN', method: 'POST', url: '/v1/admin/users/usr_farhan/activate' },
    { as: 'ADMIN', method: 'DELETE', url: '/v1/admin/users/usr_tom', body: { confirmEmail: 'tom@saffronloop.studio' } },
    { as: 'ADMIN', method: 'POST', url: '/v1/admin/teams', body: { name: 'Self-test team', managerIds: [] }, expect: 201 },
    { as: 'ADMIN', method: 'PATCH', url: '/v1/admin/teams/team_video', body: { name: 'Video & Motion Lab' } },
    { as: 'ADMIN', method: 'POST', url: '/v1/admin/teams/team_video/managers', body: { userId: 'usr_rhea' }, expect: 201 },
    { as: 'ADMIN', method: 'DELETE', url: '/v1/admin/teams/team_video/managers/usr_rhea' },
    { as: 'ADMIN', method: 'DELETE', url: '/v1/admin/teams/team_video' },
    { as: 'ADMIN', method: 'POST', url: '/v1/admin/shifts', body: { name: 'Self-test shift', schedule: { mon: { start: '09:00', end: '18:00' }, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null }, bufferMin: 10 }, expect: 201 },
    { as: 'ADMIN', method: 'PATCH', url: '/v1/admin/shifts/shf_weekend', body: { bufferMin: 20 } },
    { as: 'ADMIN', method: 'DELETE', url: '/v1/admin/shifts/shf_weekend' },
    { as: 'ADMIN', method: 'PATCH', url: '/v1/admin/workspace-policy', body: { captureTitles: true } },
    { as: 'ADMIN', method: 'PATCH', url: '/v1/admin/payroll/policy', body: { monthlyLowerMin: 9000 } },
    { as: 'ADMIN', method: 'POST', url: '/v1/admin/api-tokens', body: { name: 'Self-test token', scopes: ['read:people'] }, expect: 201 },
    { as: 'ADMIN', method: 'POST', url: '/v1/admin/api-tokens/tok_it/revoke' },
    { as: 'ADMIN', method: 'POST', url: '/v1/admin/leave/holidays', body: { date: addDays(todayKey(), 40), name: 'Self-test holiday' }, expect: 201 },
    { as: 'ADMIN', method: 'DELETE', url: '/v1/admin/leave/holidays/hol_next2' },
    { as: 'ADMIN', method: 'PATCH', url: '/v1/admin/leave/members/usr_emily', body: { accrualDays: 1.5, joinedOn: null, lastSaturdayOff: true } },
    { as: 'ADMIN', method: 'POST', url: '/v1/admin/leave/adjust', body: { userId: 'usr_emily', days: 0.5, effectiveOn: todayKey(), reason: 'Self-test' }, expect: 201 },
    { as: 'MEMBER', method: 'POST', url: '/v1/auth/login', body: { email: 'x@y.z', password: 'x' } },
    { as: 'MEMBER', method: 'POST', url: '/v1/auth/cookie-logout' },
  ];
}

export function selfTest(): SelfTestReport {
  const original: MockSettings = { ...getSettings() };
  getDb(todayKey());
  const snapshot = exportDb();
  const hit = new Set<string>();
  const unmatched: string[] = [];
  const problems: SelfTestProblem[] = [];
  let calls = 0;

  const run = (c: Case, role: Role, empty: boolean): MockResult => {
    const url = new URL(c.url, 'http://mock.local');
    const r = handle(c.method, url, c.body, { ...original, role, empty, errors: false, signedOut: false, latencyMs: 0 });
    calls += 1;
    if (r.pattern) hit.add(`${c.method} ${r.pattern}`);
    else unmatched.push(`${c.method} ${url.pathname}`);
    const expected = c.expect ?? 200;
    if (r.status !== expected) {
      problems.push({ role, empty, method: c.method, url: c.url, status: r.status, detail: JSON.stringify(r.json ?? '').slice(0, 200) });
    } else if (r.issue) {
      problems.push({ role, empty, method: c.method, url: c.url, status: r.status, detail: `schema: ${r.issue}` });
    }
    return r;
  };

  try {
    for (const empty of [false, true]) {
      for (const role of ['ADMIN', 'MANAGER', 'MEMBER'] as const) {
        for (const c of readCases()) {
          if (c.roles && !c.roles.includes(role)) continue;
          // An empty workspace has nobody else to drill into.
          if (empty && /userId=usr_|\/users\/usr_/.test(c.url)) continue;
          run(c, role, empty);
        }
      }
    }
    // A case whose target no longer exists in this session is skipped, not failed.
    for (const c of writeCases()) if (!c.url.includes('missing')) run(c, c.as, false);
  } finally {
    if (snapshot) importDb(snapshot);
    updateSettings(original);
  }

  const uncovered = listRoutes()
    .map((r) => `${r.method} ${r.pattern}`)
    .filter((k) => !hit.has(k));
  return { calls, problems, uncovered, unmatched };
}
