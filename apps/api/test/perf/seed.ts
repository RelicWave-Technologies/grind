import { prisma } from '@grind/db';
import { dateKeyInTimeZone } from '@grind/types';
import { reconcileMonthRules, resolveReportMonth } from '../../src/reports/monthPerformanceData';

/**
 * Production-shaped volume for the endpoint benchmark: one workspace in
 * Asia/Kolkata, 1 admin + 4 managers + 80 members, 45 days of history.
 *
 * Per person per working day (Mon–Sat): two tracked entries (09:30–13:00 with a
 * 30-minute meeting, 14:00–18:30), a sample per tracked minute (~480), a
 * screenshot every 10 minutes (~48) and a door punch. Half the people have an
 * open protocol-v2 timer right now. On top: approved leave and WFH, monthly
 * accruals since 2025-01, ~25 decided manual-time requests each plus ~60
 * pending, 5000 open anti-cheat flags, a few invalidations, overrides and
 * holidays, and 240 more days of entries (no samples) behind the 45. The attendance rules are on, and the rule ledger is reconciled
 * the way the scheduler does it, so the reports read realistic rule lines.
 *
 * Bulk rows are generated in SQL (generate_series) — ~1.5M samples in seconds.
 */

export const PERF_WS = 'ws_perf_bench';
export const TZ = 'Asia/Kolkata';
export const DAYS = 45;
/** Older entries (no samples or screenshots) before the 45 days. */
const HISTORY_DAYS = 240;
const MEMBERS = 80;
const MANAGERS = 4;

export const SIX_DAY = {
  mon: { start: '09:00', end: '18:00' },
  tue: { start: '09:00', end: '18:00' },
  wed: { start: '09:00', end: '18:00' },
  thu: { start: '09:00', end: '18:00' },
  fri: { start: '09:00', end: '18:00' },
  sat: { start: '09:00', end: '18:00' },
  sun: null,
};

export interface PerfFixture {
  workspaceId: string;
  adminId: string;
  managerId: string;
  memberId: string;
}

export async function ensurePerfSeed(): Promise<PerfFixture> {
  const existing = await prisma.workspace.findUnique({ where: { id: PERF_WS }, select: { id: true } });
  const stamp = await prisma.$queryRawUnsafe<Array<{ d: string }>>(
    `SELECT to_char((now() AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS d`,
  );
  const marker = await prisma.workspace.findUnique({ where: { id: PERF_WS }, select: { name: true } });
  if (!existing || marker?.name !== `perf-${stamp[0]!.d}` || process.env.PERF_RESEED) {
    await seed(stamp[0]!.d);
  }
  return fixture();
}

async function fixture(): Promise<PerfFixture> {
  const admin = await prisma.user.findFirstOrThrow({ where: { workspaceId: PERF_WS, role: 'ADMIN' } });
  const manager = await prisma.user.findFirstOrThrow({ where: { workspaceId: PERF_WS, role: 'MANAGER' }, orderBy: { id: 'asc' } });
  const member = await prisma.user.findFirstOrThrow({ where: { workspaceId: PERF_WS, role: 'MEMBER' }, orderBy: { id: 'asc' } });
  return { workspaceId: PERF_WS, adminId: admin.id, managerId: manager.id, memberId: member.id };
}

async function exec(sql: string) {
  await prisma.$executeRawUnsafe(sql);
}

async function seed(today: string) {
  const t0 = Date.now();
  // The benchmark owns its database (PERF_DATABASE_URL): start from empty.
  await exec(`DO $$ DECLARE r record; BEGIN
    FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' LOOP
      EXECUTE format('TRUNCATE TABLE %I CASCADE', r.tablename);
    END LOOP; END $$`);

  await exec(`INSERT INTO "Workspace"(id, name, timezone) VALUES ('${PERF_WS}', 'perf-seeding', '${TZ}')`);
  const rulesFrom = shiftDate(today, -DAYS - 20);
  await exec(`INSERT INTO "LeavePolicy"(id, "workspaceId", "attendanceRulesFrom", "updatedAt")
              VALUES ('plp', '${PERF_WS}', '${rulesFrom}', now())`);
  await exec(`INSERT INTO "Team"(id, "workspaceId", name, "updatedAt")
              SELECT 'pt_' || t, '${PERF_WS}', 'Team ' || t, now() FROM generate_series(1, ${MANAGERS}) t`);
  await exec(`INSERT INTO "Shift"(id, "workspaceId", name, schedule, "updatedAt")
              VALUES ('psh', '${PERF_WS}', 'General', '${JSON.stringify(SIX_DAY)}'::jsonb, now())`);

  // Users: pu_000 admin, pu_001..004 managers, pu_005.. members.
  await exec(`INSERT INTO "User"(id, "workspaceId", email, name, role, "teamId", "shiftId", "provisioningStatus", "joinedOn", "createdAt")
    SELECT 'pu_' || lpad(i::text, 3, '0'), '${PERF_WS}', 'perf' || i || '@perf.local', 'Person ' || lpad(i::text, 3, '0'),
           (CASE WHEN i = 0 THEN 'ADMIN' WHEN i <= ${MANAGERS} THEN 'MANAGER' ELSE 'MEMBER' END)::"Role",
           CASE WHEN i = 0 THEN NULL ELSE 'pt_' || (1 + (i % ${MANAGERS})) END,
           'psh', 'ACTIVE', DATE '2025-01-01', now() - interval '400 days'
    FROM generate_series(0, ${MANAGERS + MEMBERS}) i`);
  await exec(`INSERT INTO "TeamManager"(id, "workspaceId", "teamId", "userId")
    SELECT 'ptm_' || i, '${PERF_WS}', 'pt_' || (1 + (i % ${MANAGERS})), 'pu_' || lpad(i::text, 3, '0')
    FROM generate_series(1, ${MANAGERS}) i`);
  await exec(`INSERT INTO "ShiftAssignment"(id, "userId", "shiftId", "effectiveFrom", "shiftNameSnapshot", "scheduleSnapshot", "bufferMinSnapshot")
    SELECT 'psa_' || id, id, 'psh', TIMESTAMP '2020-01-01', 'General', '${JSON.stringify(SIX_DAY)}'::jsonb, 30
    FROM "User" WHERE "workspaceId" = '${PERF_WS}'`);

  // Working days (Mon–Sat) before today, per person.
  await exec(`DROP TABLE IF EXISTS perf_ud`);
  await exec(`CREATE UNLOGGED TABLE perf_ud AS
    SELECT u.id AS uid, (row_number() OVER (ORDER BY u.id))::int AS idx, d::date AS day
    FROM "User" u CROSS JOIN generate_series(DATE '${today}' - ${DAYS}, DATE '${today}' - 1, interval '1 day') d
    WHERE u."workspaceId" = '${PERF_WS}' AND extract(dow FROM d) <> 0`);
  await exec(`UPDATE perf_ud SET idx = ('x' || substr(md5(uid), 1, 4))::bit(16)::int`);

  // Entries: morning (with a meeting) and afternoon, timestamps stored as UTC.
  await exec(`INSERT INTO "TimeEntry"(id, "clientUuid", "userId", "larkTaskGuid", source, "startedAt", "endedAt", "trackingProtocolVersion", "createdAt", "updatedAt")
    SELECT 'pte_' || uid || '_' || to_char(day, 'YYYYMMDD') || '_' || part,
           'pcu_' || uid || '_' || to_char(day, 'YYYYMMDD') || '_' || part,
           uid,
           CASE WHEN part = 1 OR extract(day FROM day)::int % 2 = 0 THEN 'task_' || ((idx + extract(doy FROM day)::int + part) % 12) END,
           'AUTO',
           day + (CASE WHEN part = 1 THEN time '09:30' ELSE time '14:00' END) - interval '5 hours 30 minutes',
           day + (CASE WHEN part = 1 THEN time '13:00' ELSE time '18:30' END) - interval '5 hours 30 minutes',
           2, now(), now()
    FROM perf_ud CROSS JOIN (VALUES (1), (2)) p(part)`);
  await exec(`INSERT INTO "TimeSegment"(id, "timeEntryId", kind, "startedAt", "endedAt")
    SELECT e.id || '_s' || s.n, e.id, s.kind::"SegmentKind",
           e."startedAt" + s.a * interval '1 minute',
           e."startedAt" + s.b * interval '1 minute'
    FROM "TimeEntry" e
    JOIN (VALUES (1, 'WORK', 0, 90), (2, 'MEETING', 90, 120), (3, 'WORK', 120, 210)) s(n, kind, a, b) ON e.id LIKE '%\\_1'
    WHERE e."userId" LIKE 'pu\\_%'
    UNION ALL
    SELECT e.id || '_s1', e.id, 'WORK', e."startedAt", e."endedAt"
    FROM "TimeEntry" e WHERE e."userId" LIKE 'pu\\_%' AND e.id LIKE '%\\_2'`);

  // An open v2 timer right now for every other person.
  await exec(`INSERT INTO "TimeEntry"(id, "clientUuid", "userId", "larkTaskGuid", source, "startedAt", "endedAt", "trackingProtocolVersion", "lastProvenAt", "leaseExpiresAt", "createdAt", "updatedAt")
    SELECT 'pte_' || id || '_open', 'pcu_' || id || '_open', id, 'task_3', 'AUTO',
           date_trunc('minute', now() AT TIME ZONE 'UTC') - interval '2 hours', NULL, 2,
           (now() AT TIME ZONE 'UTC') - interval '30 seconds', (now() AT TIME ZONE 'UTC') + interval '10 minutes', now(), now()
    FROM "User" WHERE "workspaceId" = '${PERF_WS}' AND right(id, 1) IN ('0', '2', '4', '6', '8')`);
  await exec(`INSERT INTO "TimeSegment"(id, "timeEntryId", kind, "startedAt", "endedAt")
    SELECT id || '_s1', id, 'WORK', "startedAt", NULL FROM "TimeEntry" WHERE id LIKE 'pte\\_%\\_open'`);

  // One sample per tracked minute.
  await exec(`INSERT INTO "ActivitySample"(id, "userId", "timeEntryId", "bucketStart", keystrokes, clicks, "mouseDistancePx", "scrollEvents", "activeApp", "activeAppBundle", "createdAt")
    SELECT 'pas_' || e."userId" || '_' || extract(epoch FROM m)::bigint, e."userId", e.id, m,
           (extract(minute FROM m)::int * 7) % 90, (extract(minute FROM m)::int * 3) % 25,
           (extract(minute FROM m)::int * 113) % 4000, extract(minute FROM m)::int % 6,
           (ARRAY['Google Chrome', 'Visual Studio Code', 'Slack', 'Figma', 'Terminal'])[1 + extract(minute FROM m)::int % 5],
           (ARRAY['com.google.Chrome', 'com.microsoft.VSCode', 'com.tinyspeck.slackmacgap', 'com.figma.Desktop', 'com.apple.Terminal'])[1 + extract(minute FROM m)::int % 5],
           m + interval '2 minutes'
    FROM "TimeEntry" e
    CROSS JOIN LATERAL generate_series(e."startedAt", COALESCE(e."endedAt", date_trunc('minute', now() AT TIME ZONE 'UTC')) - interval '1 minute', interval '1 minute') m
    WHERE e."userId" LIKE 'pu\\_%'`);

  // A screenshot every 10 minutes.
  await exec(`INSERT INTO "Screenshot"(id, "userId", "timeEntryId", "displayId", "capturedAt", "s3Key", "thumbS3Key", bytes, width, height, "uploadState", "createdAt", "updatedAt")
    SELECT 'pss_' || e."userId" || '_' || extract(epoch FROM m)::bigint, e."userId", e.id, '1', m + interval '17 seconds',
           'shots/' || e."userId" || '/' || extract(epoch FROM m)::bigint || '.jpg',
           'thumbs/' || e."userId" || '/' || extract(epoch FROM m)::bigint || '.jpg',
           180000, 2560, 1600, 'UPLOADED', m + interval '1 minute', m + interval '1 minute'
    FROM "TimeEntry" e
    CROSS JOIN LATERAL generate_series(e."startedAt", COALESCE(e."endedAt", now() AT TIME ZONE 'UTC') - interval '1 minute', interval '10 minutes') m
    WHERE e."userId" LIKE 'pu\\_%'`);

  // Older history: entries and segments only (screenshots are retained 60
  // days), so range reads have to skip months of rows the way production does.
  await exec(`INSERT INTO "TimeEntry"(id, "clientUuid", "userId", "larkTaskGuid", source, "startedAt", "endedAt", "trackingProtocolVersion", "createdAt", "updatedAt")
    SELECT 'pth_' || u.id || '_' || to_char(d, 'YYYYMMDD') || '_' || part,
           'pch_' || u.id || '_' || to_char(d, 'YYYYMMDD') || '_' || part,
           u.id, CASE WHEN part = 1 THEN 'task_old_' || (extract(doy FROM d)::int % 30) END, 'AUTO',
           d + (CASE WHEN part = 1 THEN time '09:30' ELSE time '14:00' END) - interval '5 hours 30 minutes',
           d + (CASE WHEN part = 1 THEN time '13:00' ELSE time '18:30' END) - interval '5 hours 30 minutes',
           NULL, now(), now()
    FROM "User" u
    CROSS JOIN generate_series(DATE '${today}' - ${DAYS + HISTORY_DAYS}, DATE '${today}' - ${DAYS + 1}, interval '1 day') d
    CROSS JOIN (VALUES (1), (2)) p(part)
    WHERE u."workspaceId" = '${PERF_WS}' AND extract(dow FROM d) <> 0`);
  await exec(`INSERT INTO "TimeSegment"(id, "timeEntryId", kind, "startedAt", "endedAt")
    SELECT id || '_s1', id, 'WORK', "startedAt", "endedAt" FROM "TimeEntry" WHERE id LIKE 'pth\\_%'`);

  // Door punches: 09:05..09:44 (some late against 09:00 + grace), out 18:40.
  await exec(`INSERT INTO "AttendancePunch"(id, "workspaceId", "userId", date, "punchInAt", "punchOutAt", "updatedAt")
    SELECT 'pp_' || uid || '_' || to_char(day, 'YYYYMMDD'), '${PERF_WS}', uid, day,
           time '09:05' + ((idx * 7 + extract(doy FROM day)::int) % 40) * interval '1 minute', time '18:40', now()
    FROM perf_ud`);

  // Leave, WFH, holidays, overrides.
  await exec(`INSERT INTO "LeaveRequest"(id, "clientUuid", "workspaceId", "userId", "startDate", "endDate", reason, status, "updatedAt")
    SELECT 'plr_' || uid || '_' || k, 'plrc_' || uid || '_' || k, '${PERF_WS}', uid,
           DATE '${today}' - (5 + (idx + k * 13) % 40), DATE '${today}' - (5 + (idx + k * 13) % 40), 'perf', 'APPROVED', now()
    FROM (SELECT DISTINCT uid, idx FROM perf_ud) u CROSS JOIN generate_series(1, 3) k`);
  await exec(`INSERT INTO "LeaveRequest"(id, "clientUuid", "workspaceId", "userId", "startDate", "endDate", reason, status, "updatedAt")
    SELECT 'plo_' || uid || '_' || k, 'ploc_' || uid || '_' || k, '${PERF_WS}', uid,
           DATE '${today}' - (200 + k * 30), DATE '${today}' - (200 + k * 30), 'old', 'APPROVED', now()
    FROM (SELECT DISTINCT uid FROM perf_ud) u CROSS JOIN generate_series(1, 4) k`);
  await exec(`INSERT INTO "WfhRequest"(id, "workspaceId", "userId", "startDate", "endDate", reason, status, "larkInstanceCode", "updatedAt")
    SELECT 'pwfh_' || uid, '${PERF_WS}', uid, DATE '${today}' - (3 + idx % 30), DATE '${today}' - (2 + idx % 30), 'perf', 'APPROVED', 'pinst_' || uid, now()
    FROM (SELECT DISTINCT uid, idx FROM perf_ud) u`);
  await exec(`INSERT INTO "CompanyHoliday"(id, "workspaceId", date, name, "updatedAt")
    VALUES ('ph1', '${PERF_WS}', DATE '${today}' - 12, 'Perf holiday', now()), ('ph2', '${PERF_WS}', DATE '${today}' - 33, 'Perf holiday 2', now())`);
  await exec(`INSERT INTO "AttendanceOverride"(id, "workspaceId", "userId", date, code, reason, "updatedAt")
    SELECT 'pao_' || uid, '${PERF_WS}', uid, DATE '${today}' - (4 + idx % 20), 'P', 'perf', now()
    FROM (SELECT DISTINCT uid, idx FROM perf_ud) u WHERE idx % 3 = 0`);
  await exec(`INSERT INTO "LeaveLedgerEntry"(id, "workspaceId", "userId", kind, days, "effectiveOn", "sourceKey")
    SELECT 'pll_' || u.id || '_' || to_char(m, 'YYYYMM'), '${PERF_WS}', u.id, 'ACCRUAL', 1, m::date, 'accrual:' || u.id || ':' || to_char(m, 'YYYY-MM')
    FROM "User" u CROSS JOIN generate_series(DATE '2025-01-01', DATE '${today}', interval '1 month') m
    WHERE u."workspaceId" = '${PERF_WS}'`);

  // Manual time: ~25 decided per person, ~60 pending in all, a few left waiting for weeks.
  await exec(`INSERT INTO "ManualTimeRequest"(id, "clientUuid", "userId", "larkTaskGuid", "requestedStart", "requestedEnd", reason, status, "decidedAt", "decidedReason", "createdAt", "updatedAt")
    SELECT 'pm_' || uid || '_' || to_char(day, 'YYYYMMDD'), 'pmc_' || uid || '_' || to_char(day, 'YYYYMMDD'), uid, 'task_1',
           day + time '19:00' - interval '5 hours 30 minutes', day + time '20:00' - interval '5 hours 30 minutes', 'Worked offline on the release',
           (ARRAY['APPROVED', 'APPROVED', 'REJECTED', 'CANCELLED'])[1 + (idx + extract(doy FROM day)::int) % 4]::"ManualTimeRequestStatus",
           day + interval '1 day 4 hours', 'ok', day + interval '20 hours', now()
    FROM perf_ud WHERE (idx + extract(doy FROM day)::int) % 3 <> 0 AND day < DATE '${today}' - 2`);
  await exec(`INSERT INTO "ManualTimeRequest"(id, "clientUuid", "userId", "larkTaskGuid", "requestedStart", "requestedEnd", reason, status, "createdAt", "updatedAt")
    SELECT 'pmp_' || uid || '_' || to_char(day, 'YYYYMMDD'), 'pmpc_' || uid || '_' || to_char(day, 'YYYYMMDD'), uid, 'task_2',
           day + time '19:00' - interval '5 hours 30 minutes', day + time '20:30' - interval '5 hours 30 minutes', 'Client call after hours',
           'PENDING', day + interval '20 hours', now()
    FROM perf_ud WHERE (day >= DATE '${today}' - 2 AND idx % 3 = 0) OR (day = DATE '${today}' - 40 AND idx % 10 = 0)`);
  await exec(`INSERT INTO "ManualTimeLarkMessage"(id, "requestId", version, "recipientOpenId", kind, status, "createdAt", "updatedAt")
    SELECT 'pmm_' || id, id, 1, 'ou_perf', 'APPROVAL', 'SENT', now(), now() FROM "ManualTimeRequest" WHERE id LIKE 'pm%'`);

  // Anti-cheat flags (open) and a few invalidations.
  await exec(`INSERT INTO "ActivityFlag"(id, "userId", type, "windowStart", "windowEnd", evidence, "riskScore", status, "createdAt")
    SELECT 'paf_' || i, 'pu_' || lpad((5 + i % ${MEMBERS})::text, 3, '0'), 'JIGGLER',
           (now() AT TIME ZONE 'UTC') - (i % (${DAYS} * 1440)) * interval '1 minute' - interval '1 hour',
           (now() AT TIME ZONE 'UTC') - (i % (${DAYS} * 1440)) * interval '1 minute' - interval '59 minutes',
           '{}'::jsonb, 0.6, 'OPEN', now() - i * interval '1 second'
    FROM generate_series(1, 5000) i`);
  await exec(`INSERT INTO "ActivityFlag"(id, "userId", type, "windowStart", "windowEnd", evidence, "riskScore", status, "createdAt")
    SELECT 'pafi_' || uid, uid, 'JIGGLER', day + time '10:00' - interval '5 hours 30 minutes', day + time '10:30' - interval '5 hours 30 minutes', '{}'::jsonb, 0.9, 'RESOLVED', now()
    FROM perf_ud WHERE day = DATE '${today}' - 3 AND idx % 4 = 0`);
  await exec(`INSERT INTO "TimeInvalidation"(id, "workspaceId", "flagId", "userId", "windowStart", "windowEnd", reason)
    SELECT 'pti_' || id, '${PERF_WS}', id, "userId", "windowStart", "windowEnd", 'perf' FROM "ActivityFlag" WHERE id LIKE 'pafi\\_%'`);

  await exec(`DROP TABLE IF EXISTS perf_ud`);
  await exec(`ANALYZE`);

  // Rule ledger, the way the scheduler leaves it (current + previous month).
  const userIds = (await prisma.user.findMany({ where: { workspaceId: PERF_WS }, select: { id: true } })).map((u) => u.id);
  const month = dateKeyInTimeZone(new Date(), TZ).slice(0, 7);
  for (const m of [previousMonth(month), month]) {
    const range = resolveReportMonth({ month: m }, TZ);
    if ('error' in range) throw new Error(range.error);
    await reconcileMonthRules({ workspaceId: PERF_WS, userIds, range });
  }
  // Marks the seed complete (a failed run leaves 'perf-seeding' and reseeds).
  await exec(`UPDATE "Workspace" SET name = 'perf-${today}' WHERE id = '${PERF_WS}'`);
  const counts = await prisma.$queryRawUnsafe<Array<{ t: string; n: bigint }>>(`
    SELECT 'TimeEntry' t, count(*) n FROM "TimeEntry" WHERE "userId" LIKE 'pu\\_%'
    UNION ALL SELECT 'TimeSegment', count(*) FROM "TimeSegment" WHERE "timeEntryId" LIKE 'pte\\_%'
    UNION ALL SELECT 'ActivitySample', count(*) FROM "ActivitySample" WHERE "userId" LIKE 'pu\\_%'
    UNION ALL SELECT 'Screenshot', count(*) FROM "Screenshot" WHERE "userId" LIKE 'pu\\_%'
    UNION ALL SELECT 'AttendancePunch', count(*) FROM "AttendancePunch" WHERE "workspaceId" = '${PERF_WS}'
    UNION ALL SELECT 'ManualTimeRequest', count(*) FROM "ManualTimeRequest" WHERE "userId" LIKE 'pu\\_%'
    UNION ALL SELECT 'LeaveLedgerEntry', count(*) FROM "LeaveLedgerEntry" WHERE "userId" LIKE 'pu\\_%'`);
  console.log(`[perf] seeded in ${Math.round((Date.now() - t0) / 1000)}s`, counts.map((c) => `${c.t}=${c.n}`).join(' '));
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
