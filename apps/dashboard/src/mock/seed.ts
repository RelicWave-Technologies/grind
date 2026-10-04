/**
 * Builds a fresh store relative to today. Tracked time is generated on
 * demand; this seeds the rows around it — requests placed into real gaps,
 * leave, holidays, flags, tokens, audits, corrections and payroll runs.
 */
import { PAYROLL_POLICY_DEFAULTS } from '@grind/types';
import type { TriageResult } from '../lib/types';
import { chargedDaysFor, freeSlots } from './activity';
import {
  addDays,
  atMinute,
  compareKeys,
  DAY,
  HOUR,
  MIN,
  monthBounds,
  monthOf,
  nextWeekday,
  noonOf,
  prevWeekday,
  shiftMonth,
  todayKey,
  TZ,
} from './clock';
import { DB_VERSION, type DbLeaveRequest, type DbRequest, type DbUser, type MockDb } from './db';
import { avatarDataUrl } from './images';
import { ARCHIVED_TASK_GUID, PEOPLE, SHIFTS, TASKS, TEAM_MANAGERS, TEAMS, type Discipline } from './people';
import { rngFor } from './rng';

const REASONS: Record<Discipline, string[]> = {
  design: [
    'Client workshop at the Northwind office — laptop stayed closed',
    'Usability sessions in the meeting room, no laptop',
    'Sketching concepts on paper before the review',
    'Travelled to the print vendor to check proofs',
    'Moodboards on the iPad during the flight back from Bengaluru',
  ],
  eng: [
    'Agent crashed after the macOS update — worked without tracking',
    'Pair-programmed on Arjun’s machine',
    'Production incident call from my phone',
    'Whiteboard session on the new sync design',
    'Deploy window — watched dashboards from the phone',
  ],
  growth: [
    'Client visit in Bandra — Kestrel Analytics',
    'Conference booth at SaaSBOOMi',
    'Calls from the car between meetings',
    'Offsite pitch rehearsal with Nisha',
  ],
  ops: ['Bank visit for payroll signatories', 'Vendor walkthrough at the new office'],
};

const REJECTIONS = [
  'Please attach the files from this block — I can’t verify it.',
  'This overlaps time that was already tracked that day.',
  'Log this under the client task, not untracked.',
  'Duplicate of the request you sent earlier in the week.',
];

type Scenario = [daysAgo: number, status: DbRequest['status'], opts?: { archived?: boolean; untracked?: boolean }];

const SCENARIOS: Record<string, Scenario[]> = {
  usr_ananya: [[0, 'PENDING'], [1, 'APPROVED'], [2, 'REJECTED'], [3, 'CANCELLED'], [5, 'PENDING', { untracked: true }], [7, 'APPROVED', { untracked: true }], [12, 'APPROVED']],
  usr_kabir: [[2, 'APPROVED'], [9, 'APPROVED']],
  usr_sofia: [[1, 'PENDING'], [4, 'APPROVED'], [8, 'REJECTED']],
  usr_rhea: [[0, 'PENDING'], [3, 'PENDING'], [6, 'APPROVED']],
  usr_arjun: [[1, 'APPROVED'], [6, 'APPROVED']],
  usr_vikram: [[1, 'PENDING'], [2, 'PENDING'], [4, 'REJECTED'], [10, 'APPROVED']],
  usr_daniel: [[2, 'PENDING'], [5, 'APPROVED']],
  usr_priya: [[0, 'PENDING'], [6, 'CANCELLED'], [9, 'APPROVED']],
  usr_hiroshi: [[3, 'APPROVED'], [7, 'REJECTED']],
  usr_nisha: [[4, 'APPROVED']],
  usr_rohan: [[1, 'PENDING'], [2, 'APPROVED'], [5, 'PENDING', { untracked: true }], [11, 'REJECTED']],
  usr_emily: [[3, 'APPROVED'], [8, 'APPROVED']],
  usr_aditya: [[1, 'PENDING', { archived: true }], [4, 'REJECTED']],
  usr_meera: [[3, 'APPROVED']],
};

function round5(ms: number, up: boolean): number {
  const step = 5 * MIN;
  return (up ? Math.ceil(ms / step) : Math.floor(ms / step)) * step;
}

function triageFor(u: DbUser, r: { larkTaskGuid: string | null; start: number; end: number }, rejectedBefore: number): TriageResult {
  const rng = rngFor('triage', u.id, r.start);
  const signals: TriageResult['signals'] = [];
  const hours = (r.end - r.start) / HOUR;
  signals.push({ id: 'fills_gap', text: 'Fills an empty stretch inside the shift', weight: 0.35 });
  if (r.larkTaskGuid) signals.push({ id: 'has_task', text: 'Linked to a Lark task the person worked on this week', weight: 0.25 });
  else signals.push({ id: 'no_task', text: 'No Lark task attached', weight: -0.2 });
  if (hours > 2) signals.push({ id: 'long', text: `Long block — ${hours.toFixed(1)}h in one request`, weight: -0.25 });
  if (rejectedBefore > 0) signals.push({ id: 'history', text: `${rejectedBefore} rejected request${rejectedBefore === 1 ? '' : 's'} in the last 30 days`, weight: -0.3 });
  if (rng.chance(0.5)) signals.push({ id: 'calendar', text: 'Matches an event on their Lark calendar', weight: 0.3 });
  const score = signals.reduce((s, x) => s + x.weight, 0);
  const verdict = score >= 0.4 ? 'approve' : score >= 0 ? 'review' : 'reject';
  return {
    verdict,
    confidence: Math.round(Math.min(0.95, 0.55 + Math.abs(score) / 2) * 100) / 100,
    signals,
    headline:
      verdict === 'approve'
        ? 'Looks routine — fills a gap and lines up with their task and calendar.'
        : verdict === 'review'
          ? 'Plausible, but worth a quick look before approving.'
          : 'Weak evidence — long untracked block with a history of rejections.',
  };
}

export function seedDb(): MockDb {
  const today = todayKey();
  const now = Date.now();
  const createdAtFor = (daysAgo: number) => noonOf(addDays(today, -daysAgo)) - 3 * HOUR;

  const users: DbUser[] = PEOPLE.map((p) => {
    const teamId = p.team ? TEAMS.find((t) => t.key === p.team)!.id : null;
    const managerId =
      p.role === 'ADMIN' || p.status === 'pending'
        ? null
        : p.role === 'MANAGER'
          ? 'usr_meera'
          : (p.team && TEAM_MANAGERS[p.team][0]) || 'usr_meera';
    const createdAt = createdAtFor(p.joinedDaysAgo);
    return {
      id: p.id,
      name: p.name,
      email: p.email,
      role: p.role,
      activityRoleTitle: p.title,
      teamId,
      managerId,
      avatarUrl: p.avatar ? avatarDataUrl(p.id) : null,
      shiftId: p.shift,
      shiftAssignedAt: p.shift ? createdAt + DAY : null,
      createdAt,
      birthDate: p.birthDate,
      deactivatedAt: p.status === 'deactivated' ? now - 21 * DAY : null,
      provisioningStatus: p.status === 'pending' ? 'PENDING' : 'ACTIVE',
      persona: p.persona,
      discipline: p.discipline,
      agent: p.agent,
      screenshotIntervalMin: p.settings?.screenshotIntervalMin ?? null,
      idleThresholdMin: p.settings?.idleThresholdMin ?? null,
      idleWarningSeconds: p.settings?.idleWarningSeconds ?? null,
      leaveAccrualDays: p.leave?.accrualDays ?? null,
      leaveLastSaturdayOff: p.leave?.lastSaturdayOff ?? null,
      joinedOn: p.leave?.joinedOnSet ? addDays(today, -p.joinedDaysAgo) : null,
    };
  });

  const month = monthOf(today);
  const cur = monthBounds(month);
  const prev = monthBounds(shiftMonth(month, -1));
  const next = monthBounds(shiftMonth(month, 1));
  const avoidToday = (d: string) => (d === today ? nextWeekday(addDays(d, 1)) : d);

  const db: MockDb = {
    version: DB_VERSION,
    seedDay: today,
    seededAt: now,
    workspaceCreatedAt: createdAtFor(730),
    users,
    teams: TEAMS.map((t) => ({ id: t.id, name: t.name, managerIds: [...TEAM_MANAGERS[t.key]], createdAt: createdAtFor(t.createdDaysAgo) })),
    shifts: SHIFTS.map((s) => ({ id: s.id, name: s.name, schedule: s.schedule, bufferMin: s.bufferMin, createdAt: createdAtFor(s.createdDaysAgo), updatedAt: createdAtFor(Math.max(1, s.createdDaysAgo - 20)) })),
    requests: [],
    manualEntries: [],
    entryPatches: {},
    flags: [],
    tokens: [],
    holidays: [
      { id: 'hol_foundation', date: avoidToday(nextWeekday(addDays(cur.from, 4))), name: 'Studio Foundation Day', teamId: null, createdAt: createdAtFor(120) },
      { id: 'hol_regional', date: avoidToday(nextWeekday(addDays(cur.from, 19))), name: 'Regional holiday', teamId: null, createdAt: createdAtFor(120) },
      { id: 'hol_prev', date: nextWeekday(addDays(prev.from, 14)), name: 'Monsoon wellness day', teamId: null, createdAt: createdAtFor(150) },
      { id: 'hol_next1', date: nextWeekday(addDays(next.from, 6)), name: 'Wellness day', teamId: null, createdAt: createdAtFor(60) },
      { id: 'hol_next2', date: nextWeekday(addDays(next.from, 20)), name: 'Founders’ offsite', teamId: null, createdAt: createdAtFor(30) },
      { id: 'hol_growth', date: avoidToday(nextWeekday(addDays(today, 9))), name: 'Growth team offsite — Alibaug', teamId: 'team_growth', createdAt: createdAtFor(10) },
    ],
    leaveRequests: [],
    leaveAdjustments: [
      { id: 'adj_1', userId: 'usr_ananya', days: 1, effectiveOn: `${prev.from}`, reason: 'Comp-off for the Northwind launch weekend', createdAt: noonOf(prev.from) },
      { id: 'adj_2', userId: 'usr_rohan', days: -0.5, effectiveOn: `${cur.from}`, reason: 'Correction — half day recorded twice', createdAt: noonOf(cur.from) },
    ],
    leavePolicy: {
      monthlyAccrualDays: 1.5,
      carryForward: true,
      carryForwardCapDays: 12,
      allowNegativeBalance: false,
      accrueOnJoinMonth: true,
      updatedAt: createdAtFor(200),
    },
    workspacePolicy: {
      captureApps: true,
      captureTitles: false,
      captureUrls: true,
      retentionDaysScreenshots: 60,
      defaultScreenshotIntervalMin: 3,
      defaultIdleThresholdMin: 5,
      createdAt: createdAtFor(700),
      updatedAt: createdAtFor(18),
    },
    payrollPolicy: {
      ...PAYROLL_POLICY_DEFAULTS,
      approvalReminderDays: [...PAYROLL_POLICY_DEFAULTS.approvalReminderDays],
      timezone: TZ,
      approvalReminderTime: '10:00',
      payrollSheetSendTime: '11:00',
      createdAt: createdAtFor(300),
      updatedAt: createdAtFor(40),
    },
    payrollRuns: [],
    audits: [],
    overrides: [],
    overrideHistory: [],
  };

  const userOf = (id: string) => db.users.find((u) => u.id === id)!;

  // ---- Leave ---------------------------------------------------------------
  const leave = (
    id: string,
    userId: string,
    startDate: string,
    endDate: string,
    status: DbLeaveRequest['status'],
    opts: { portion?: DbLeaveRequest['portion']; kind?: DbLeaveRequest['kind']; reason: string; source?: DbLeaveRequest['decisionSource']; lark?: boolean; decidedBy?: string },
  ) => {
    const portion = opts.portion ?? 'FULL';
    const kind = opts.kind ?? 'PAID';
    const createdAt = Math.min(now - 2 * HOUR, noonOf(startDate) - 5 * DAY);
    const decided = status === 'APPROVED' || status === 'REJECTED' || status === 'CANCELLED';
    db.leaveRequests.push({
      id,
      userId,
      kind,
      startDate,
      endDate,
      portion,
      chargedDays: chargedDaysFor(db, userOf(userId), startDate, endDate, portion, kind === 'PAID'),
      reason: opts.reason,
      status,
      decisionSource: decided ? opts.source ?? 'LARK_APPROVAL' : null,
      decidedAt: decided ? Math.min(now - HOUR, createdAt + 26 * HOUR) : null,
      decidedById: decided && status !== 'CANCELLED' ? opts.decidedBy ?? 'usr_meera' : null,
      larkInstanceCode: opts.lark === false ? null : `LK${id.toUpperCase().replace(/[^A-Z0-9]/g, '')}7F3`,
      createdAt,
    });
  };
  const wd = (offset: number) => (offset >= 0 ? nextWeekday(addDays(today, offset)) : prevWeekday(addDays(today, offset)));
  const todayOrNext = nextWeekday(today);
  leave('lv_emily_today', 'usr_emily', todayOrNext, todayOrNext, 'APPROVED', { reason: 'Visiting family in Pune', decidedBy: 'usr_nisha' });
  leave('lv_sofia_half', 'usr_sofia', todayOrNext, todayOrNext, 'APPROVED', { portion: 'SECOND_HALF', reason: 'Dentist appointment', decidedBy: 'usr_kabir' });
  leave('lv_ananya_wedding', 'usr_ananya', wd(-16), nextWeekday(addDays(wd(-16), 1)), 'APPROVED', { reason: 'Sister’s wedding in Chennai', decidedBy: 'usr_kabir' });
  leave('lv_ananya_half', 'usr_ananya', wd(-9), wd(-9), 'APPROVED', { portion: 'FIRST_HALF', reason: 'Passport appointment', decidedBy: 'usr_kabir' });
  leave('lv_ananya_coorg', 'usr_ananya', wd(6), nextWeekday(addDays(wd(6), 1)), 'PENDING', { reason: 'Long weekend trip to Coorg' });
  leave('lv_ananya_declined', 'usr_ananya', wd(22), wd(22), 'REJECTED', { reason: 'Friend’s housewarming', decidedBy: 'usr_kabir' });
  leave('lv_ananya_cancel', 'usr_ananya', wd(-26), wd(-26), 'CANCELLED', { kind: 'UNPAID', reason: 'Bike service', source: 'REQUESTER_CANCEL', lark: false });
  leave('lv_rohan_move', 'usr_rohan', wd(4), nextWeekday(addDays(wd(4), 1)), 'APPROVED', { kind: 'UNPAID', reason: 'Moving house', source: 'DASHBOARD', lark: false, decidedBy: 'usr_meera' });
  leave('lv_hiroshi_fever', 'usr_hiroshi', wd(-6), wd(-6), 'APPROVED', { reason: 'Fever', decidedBy: 'usr_arjun' });
  leave('lv_daniel_family', 'usr_daniel', wd(12), wd(12), 'PENDING', { reason: 'Family function', lark: false });
  leave('lv_kabir_vacation', 'usr_kabir', wd(18), nextWeekday(addDays(wd(18), 2)), 'APPROVED', { reason: 'Vacation — Meghalaya', decidedBy: 'usr_meera' });
  leave('lv_arjun_personal', 'usr_arjun', wd(-11), wd(-11), 'APPROVED', { reason: 'Personal', decidedBy: 'usr_meera' });
  leave('lv_priya_conf', 'usr_priya', wd(-20), nextWeekday(addDays(wd(-20), 1)), 'APPROVED', { reason: 'JSConf India', decidedBy: 'usr_arjun' });

  // ---- Manual time requests, placed into real gaps --------------------------
  let n = 0;
  const rejectedCount = new Map<string, number>();
  /** Slots already used, so two scenarios never stack on the same stretch. */
  const claimed: Array<{ userId: string; start: number; end: number }> = [];
  for (const [userId, scenarios] of Object.entries(SCENARIOS)) {
    const u = userOf(userId);
    const rng = rngFor('requests', userId);
    const approver =
      u.role === 'MEMBER'
        ? db.teams.find((t) => t.id === u.teamId)?.managerIds[0] ?? 'usr_meera'
        : u.id;
    for (const [daysAgo, status, opts] of [...scenarios].sort((a, b) => b[0] - a[0])) {
      let date = daysAgo === 0 ? today : prevWeekday(addDays(today, -daysAgo));
      let slot: { start: number; end: number } | undefined;
      for (let tries = 0; tries < 4 && !slot; tries++) {
        const slots = freeSlots(db, u, date, now).filter(
          (s) => s.end - s.start >= 25 * MIN && !claimed.some((c) => c.userId === userId && s.start < c.end && s.end > c.start),
        );
        slot = slots.sort((a, b) => b.end - b.start - (a.end - a.start))[Math.min(slots.length - 1, tries % 2)];
        if (!slot) date = prevWeekday(addDays(date, -1));
      }
      if (!slot) continue;
      const start = round5(slot.start + 5 * MIN, true);
      const end = round5(Math.min(slot.end - 5 * MIN, start + rng.int(35, 150) * MIN), false);
      if (end - start < 15 * MIN) continue;
      const teamTasks = TASKS.filter((t) => t.team !== null && db.teams.find((x) => x.id === u.teamId)?.id === `team_${t.team}`);
      const guid = opts?.archived ? ARCHIVED_TASK_GUID : opts?.untracked ? null : (teamTasks.length ? rng.pick(teamTasks) : rng.pick(TASKS)).guid;
      const auto = u.role !== 'MEMBER' && status === 'APPROVED';
      const createdAt = Math.min(now - 20 * MIN, end + rng.int(1, 6) * HOUR);
      const decidedAt = status === 'PENDING' ? null : Math.min(now - 5 * MIN, auto ? createdAt : createdAt + rng.int(2, 30) * HOUR);
      const id = `mtr_${userId.slice(4)}_${String(++n).padStart(3, '0')}`;
      const req: DbRequest = {
        id,
        clientUuid: `seed-${id}`,
        userId,
        approverId: approver,
        larkTaskGuid: guid,
        taskSummary: guid === ARCHIVED_TASK_GUID ? null : TASKS.find((t) => t.guid === guid)?.summary ?? null,
        start,
        end,
        reason: rng.pick(REASONS[u.discipline]),
        status,
        autoApproved: auto,
        decidedAt,
        decidedReason:
          status === 'REJECTED' ? rng.pick(REJECTIONS) : auto ? `Added by ${u.name}` : status === 'APPROVED' && rng.chance(0.4) ? 'Thanks — approved.' : null,
        createdAt,
        attendeeIds: [],
        timeEntryId: null,
        triage: null,
      };
      if (status === 'PENDING') req.triage = triageFor(u, req, rejectedCount.get(userId) ?? 0);
      if (status === 'REJECTED') rejectedCount.set(userId, (rejectedCount.get(userId) ?? 0) + 1);
      if (status === 'APPROVED') {
        const entryId = `te_manual_${id}`;
        req.timeEntryId = entryId;
        db.manualEntries.push({ id: entryId, userId, requestId: id, start, end, larkTaskGuid: guid, notes: null, attendeeIds: [] });
      }
      db.requests.push(req);
      claimed.push({ userId, start: slot.start, end: slot.end });
    }
  }
  // The member persona's own pending request tags a colleague as attendee.
  const ananyaToday = db.requests.find((r) => r.userId === 'usr_ananya' && r.status === 'PENDING');
  if (ananyaToday) ananyaToday.attendeeIds = ['usr_kabir'];

  // ---- Anti-cheat flags ------------------------------------------------------
  const win = (offset: number, fromMin: number, lenMin: number) => {
    const d = prevWeekday(addDays(today, offset));
    const start = atMinute(d, fromMin);
    return { windowStart: start, windowEnd: start + lenMin * MIN, createdAt: Math.min(now - 30 * MIN, start + (lenMin + 12) * MIN) };
  };
  const flag = (
    id: string,
    userId: string,
    type: MockDb['flags'][number]['type'],
    riskScore: number,
    w: ReturnType<typeof win>,
    evidence: Record<string, number>,
    explanation?: { headline: string; detail: string },
    resolved?: { resolution: 'DISMISSED' | 'CONFIRMED' | 'TIME_INVALIDATED'; by: string; note: string },
  ) => {
    db.flags.push({
      id,
      userId,
      type,
      windowStart: w.windowStart,
      windowEnd: w.windowEnd,
      riskScore,
      evidence,
      ...(explanation ? { explanation } : {}),
      status: resolved ? 'RESOLVED' : 'OPEN',
      resolution: resolved?.resolution ?? null,
      resolvedById: resolved?.by ?? null,
      resolvedAt: resolved ? Math.min(now - 10 * MIN, w.createdAt + 20 * HOUR) : null,
      resolvedNote: resolved?.note ?? null,
      createdAt: w.createdAt,
    });
  };
  flag('flg_vikram_jiggler', 'usr_vikram', 'JIGGLER', 72, win(-1, 15 * 60 + 10, 45), { movesPerMin: 2, cadenceSec: 30, clicks: 0, keystrokes: 0, appSwitches: 0 }, {
    headline: 'The mouse moved every 30 seconds for 45 minutes with no clicks, keys or app switches.',
    detail: 'The cadence varied by under 80 ms, which a hand does not do. Screens show the same VS Code file the whole time.',
  });
  flag('flg_priya_rate', 'usr_priya', 'IMPOSSIBLE_RATE', 88, win(-2, 11 * 60 + 20, 12), { keysPerMin: 1260, peakKeysPerSec: 31, windowMin: 12 }, {
    headline: '1,260 keys a minute for twelve minutes — well past human speed.',
    detail: 'Most likely a paste macro or a stuck key. The screenshots show a terminal with a long log scrolling.',
  });
  flag('flg_daniel_metro', 'usr_daniel', 'METRONOMIC', 38, win(-1, 19 * 60 + 5, 25), { intervalStdMs: 11, keysPerMin: 96 }, {
    headline: 'Keystrokes landed at an unusually even rhythm for 25 minutes.',
    detail: 'Could be a typing drill or an auto-typer. Low risk on its own — worth a quick look at the screenshots.',
  });
  flag('flg_rohan_single', 'usr_rohan', 'SINGLE_CHANNEL', 24, win(-3, 16 * 60, 50), { keystrokes: 0, clicks: 212, windowMin: 50 });
  flag('flg_aditya_linear', 'usr_aditya', 'LINEAR_MOUSE', 55, win(-2, 14 * 60 + 40, 30), { straightnessPct: 99, speedVariancePct: 2 });
  flag('flg_rhea_metro', 'usr_rhea', 'METRONOMIC', 41, win(-4, 12 * 60 + 15, 20), { intervalStdMs: 9, keysPerMin: 140 }, {
    headline: 'Twenty minutes of perfectly even typing.',
    detail: 'Rhea’s other days look normal; this may be a text expander.',
  });
  flag('flg_sofia_single', 'usr_sofia', 'SINGLE_CHANNEL', 30, win(-6, 10 * 60, 40), { keystrokes: 0, clicks: 88, windowMin: 40 }, undefined, {
    resolution: 'DISMISSED',
    by: 'usr_kabir',
    note: 'Presenting to the client with a clicker — legitimate.',
  });
  flag('flg_vikram_old', 'usr_vikram', 'JIGGLER', 81, win(-5, 14 * 60, 40), { movesPerMin: 2, cadenceSec: 30, clicks: 0, keystrokes: 0 }, {
    headline: 'Regular mouse nudges with no other input for 40 minutes.',
    detail: 'Matches a mouse-mover utility.',
  }, { resolution: 'TIME_INVALIDATED', by: 'usr_arjun', note: 'Confirmed with Vikram — mouse mover while on a call. 40 min removed.' });
  flag('flg_rohan_rate', 'usr_rohan', 'IMPOSSIBLE_RATE', 65, win(-9, 17 * 60, 15), { keysPerMin: 1180, windowMin: 15 }, undefined, {
    resolution: 'CONFIRMED',
    by: 'usr_nisha',
    note: 'CRM data-entry macro. Talked it through; no time removed.',
  });

  // ---- API tokens -----------------------------------------------------------
  db.tokens.push(
    { id: 'tok_metabase', name: 'Finance dashboard (Metabase)', tokenPrefix: 'timo_live_7Hq2', scopes: ['read:time-summary', 'read:people'], createdById: 'usr_meera', createdAt: now - 92 * DAY, lastUsedAt: now - 2 * HOUR, revokedAt: null },
    { id: 'tok_larkbot', name: 'Lark bot — standup digest', tokenPrefix: 'timo_live_Kd9x', scopes: ['read:manual-time', 'read:time-summary'], createdById: 'usr_meera', createdAt: now - 40 * DAY, lastUsedAt: now - 20 * MIN, revokedAt: null },
    { id: 'tok_it', name: 'IT device inventory', tokenPrefix: 'timo_live_p0Wn', scopes: ['read:device-health'], createdById: 'usr_meera', createdAt: now - 6 * DAY, lastUsedAt: null, revokedAt: null },
    { id: 'tok_zapier', name: 'Old Zapier sync', tokenPrefix: 'timo_live_Zz31', scopes: ['read:people'], createdById: 'usr_meera', createdAt: now - 210 * DAY, lastUsedAt: now - 35 * DAY, revokedAt: now - 30 * DAY },
  );

  // ---- Monitoring-settings audits -------------------------------------------
  const audit = (id: string, daysAgo: number, a: Omit<MockDb['audits'][number], 'id' | 'createdAt'>) =>
    db.audits.push({ id, createdAt: now - daysAgo * DAY - 3 * HOUR, ...a });
  audit('aud_1', 1, { scope: 'MEMBER_OVERRIDE', riskLevel: 'HIGH', actorId: 'usr_meera', targetUserId: 'usr_hiroshi', previousScreenshotIntervalMin: 3, previousIdleThresholdMin: 5, previousIdleWarningSeconds: null, nextScreenshotIntervalMin: 1, nextIdleThresholdMin: 5, nextIdleWarningSeconds: 20, reason: 'Aurora Bank contract requires 1-minute evidence for billed hours.' });
  audit('aud_2', 4, { scope: 'MEMBER_OVERRIDE', riskLevel: 'CAUTION', actorId: 'usr_arjun', targetUserId: 'usr_daniel', previousScreenshotIntervalMin: 3, previousIdleThresholdMin: 5, previousIdleWarningSeconds: 30, nextScreenshotIntervalMin: 3, nextIdleThresholdMin: 15, nextIdleWarningSeconds: null, reason: 'Night shift reads long incident docs.' });
  audit('aud_3', 9, { scope: 'MEMBER_OVERRIDE', riskLevel: 'NORMAL', actorId: 'usr_kabir', targetUserId: 'usr_sofia', previousScreenshotIntervalMin: 3, previousIdleThresholdMin: 5, previousIdleWarningSeconds: null, nextScreenshotIntervalMin: 2, nextIdleThresholdMin: 10, nextIdleWarningSeconds: 30, reason: null });
  audit('aud_4', 18, { scope: 'WORKSPACE_POLICY', riskLevel: 'NORMAL', actorId: 'usr_meera', targetUserId: null, previousScreenshotIntervalMin: 3, previousIdleThresholdMin: 10, previousIdleWarningSeconds: null, nextScreenshotIntervalMin: 3, nextIdleThresholdMin: 5, nextIdleWarningSeconds: null, reason: 'Align idle breaks with the payroll policy.' });
  audit('aud_5', 33, { scope: 'WORKSPACE_POLICY', riskLevel: 'CAUTION', actorId: null, targetUserId: null, previousScreenshotIntervalMin: 2, previousIdleThresholdMin: 10, previousIdleWarningSeconds: null, nextScreenshotIntervalMin: 3, nextIdleThresholdMin: 10, nextIdleWarningSeconds: null, reason: null });
  audit('aud_6', 47, { scope: 'MEMBER_OVERRIDE', riskLevel: 'NORMAL', actorId: 'usr_meera', targetUserId: null, previousScreenshotIntervalMin: 2, previousIdleThresholdMin: 5, previousIdleWarningSeconds: null, nextScreenshotIntervalMin: 3, nextIdleThresholdMin: 5, nextIdleWarningSeconds: null, reason: 'Reset after offboarding.' });

  // ---- Attendance corrections -----------------------------------------------
  const vikramAbsent = prevWeekday(addDays(today, -3));
  const rheaAbsent = prevWeekday(addDays(today, -8));
  const correction = (userId: string, date: string, code: MockDb['overrides'][number]['code'], reason: string, by: string, computed: string, ago: number) => {
    const setAt = Math.min(now - HOUR, noonOf(date) + ago * HOUR);
    db.overrides.push({ userId, date, code, reason, setById: by, setAt, computedCode: computed });
    db.overrideHistory.push({ userId, date, code, reason, computedCode: computed, setAt, setById: by });
  };
  correction('usr_vikram', vikramAbsent, 'P', 'Agent was down after the Linux update; he was in the office all day.', 'usr_arjun', 'A', 20);
  db.overrideHistory.push({ userId: 'usr_rhea', date: rheaAbsent, code: 'A', reason: 'No show, no message.', computedCode: 'A', setAt: Math.min(now - 2 * HOUR, noonOf(rheaAbsent) + 6 * HOUR), setById: 'usr_kabir' });
  correction('usr_rhea', rheaAbsent, 'HALF_LEAVE', 'She messaged later — doctor in the morning, worked from home after lunch.', 'usr_kabir', 'P', 30);

  // ---- Payroll runs ---------------------------------------------------------
  const run = (m: string, runType: 'APPROVAL_REMINDER' | 'PAYROLL_SHEET', day: number, time: string, status: MockDb['payrollRuns'][number]['status'], counts: [number, number, number, number]) => {
    const date = `${m}-${String(day).padStart(2, '0')}`;
    if (compareKeys(date, today) > 0) return;
    const [h, mm] = time.split(':').map((x) => Number.parseInt(x, 10));
    const at = atMinute(date, (h ?? 0) * 60 + (mm ?? 0));
    if (at > now) return;
    db.payrollRuns.push({ id: `run_${m}_${runType}_${day}`, month: m, runType, scheduledFor: at, status, sentCount: counts[0], skippedNoLarkCount: counts[1], skippedUnassignedCount: counts[2], failedCount: counts[3], createdAt: at + 40_000 });
  };
  for (const [m, isCurrent] of [[shiftMonth(month, -1), false], [month, true]] as const) {
    // Reminders chase the month that just closed.
    run(m, 'APPROVAL_REMINDER', 3, '10:00', 'SENT', [11, 1, 1, 0]);
    run(m, 'APPROVAL_REMINDER', 4, '10:00', isCurrent ? 'PARTIAL' : 'SENT', isCurrent ? [9, 2, 1, 1] : [12, 1, 0, 0]);
    run(m, 'PAYROLL_SHEET', 5, '11:00', 'SENT', [1, 0, 0, 0]);
  }

  return db;
}
