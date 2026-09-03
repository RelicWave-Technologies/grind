import { Router, type Request } from 'express';
import { prisma } from '@grind/db';
import type {
  ManualTimeRequestDto,
  MemberReportDayAppsResponse,
  MemberReportDayScreenshotsResponse,
  MemberReportsMeResponse,
  TeamMemberReportsResponse,
  TeamReportsSummaryResponse,
  TeamReportUser,
} from '@grind/types';
import { loadPunchLookup } from '../attendance/punches';
import { requireAccessToken } from '../middleware/auth';
import { attachScope, requireCapability } from '../middleware/scope';
import {
  buildMemberReportApps,
  buildMemberReportDays,
  buildMemberReportScreenshots,
  resolveReportRange,
  resolveSingleReportDay,
  type ReportActivitySample,
  type ReportManualRequest,
  type ReportRange,
  type ReportShiftAssignment,
  type ReportScreenshotRow,
  type ReportTimeEntry,
} from '../reports/member';
import { buildTeamReportsResponse, buildTeamReportsSummaryResponse } from '../reports/team';
import { loadProfileForUser } from '../profile/service';
import { resolveAppIcon, storedIconDataUrls } from '../insights/appIcon';
import type { IconResolver } from '../reports/member';
import { loadTimeInvalidationsForUsers } from '../insights/timeInvalidations';
import type { TimeInvalidationInput } from '../insights/invalidations';
import type { RoleTitle } from '../scoring/presets';
import { loadEntryLiveEvidence, type EntryLiveEvidenceMap } from '../insights/liveEntryEvidence';
import { timesheetCalendarInputs } from '../leave';
import { formatMonthPerformanceCsv } from '../reports/monthPerformance';
import { monthPerformanceXlsx } from '../reports/monthPerformanceXlsx';
import { loadMonthPerformanceReport, resolveReportMonth } from '../reports/monthPerformanceData';
import { computeMonthPointers, storeMonthPointers } from '../reports/monthPointersData';
import {
  clearAttendanceOverride,
  computeDayCode,
  loadOverrideLookup,
  setAttendanceOverride,
} from '../reports/attendanceOverrides';
import { SetAttendanceOverrideRequest, ClearAttendanceOverrideRequest } from '@grind/types';

export const reportsRouter = Router();
reportsRouter.use(requireAccessToken, attachScope, requireCapability('reports.self.read'));

const TEAM_REPORT_MAX_DAYS = 31;

/** Build an icon resolver that prefers real agent-extracted icons (data URLs)
 *  for the bundles seen in these samples, falling back to the brand map. */
async function iconForSamples(samples: { activeAppBundle: string | null }[]): Promise<IconResolver> {
  const stored = await storedIconDataUrls(samples.map((s) => s.activeAppBundle));
  return (app, bundle, domain) => resolveAppIcon(app, bundle, stored, domain);
}

reportsRouter.get('/me', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    const range = resolveReportRange(req.query as Record<string, unknown>, req.scope.workspaceTimezone);
    if ('error' in range) return res.status(range.status).json({ error: range.error, ...(range.extras ?? {}) });

    const now = new Date();
    const data = await loadReportData(req.user.sub, range, now);
    const iconFor = await iconForSamples(data.samples);
    const calendar = await timesheetCalendarInputs({
      workspaceId: req.scope.workspaceId,
      tz: range.tz,
      userIds: [req.user.sub],
      from: range.from,
      to: range.to,
    });
    const punchFor = await loadPunchLookup({ userIds: [req.user.sub], from: range.from, to: range.to });
    const overrideFor = await loadOverrideLookup({ userIds: [req.user.sub], from: range.from, to: range.to });
    const response: MemberReportsMeResponse = {
      from: range.from,
      to: range.to,
      tz: range.tz,
      days: buildMemberReportDays({
        dayStatusFor: calendar.dayStatusFor,
        punchFor,
        overrideFor,
        userId: req.user.sub,
        range,
        now,
        entries: data.entries,
        manualRequests: data.manualRequests,
        samples: data.samples,
        screenshots: data.screenshots,
        evidenceByEntry: data.evidenceByEntry,
        shiftAssignments: data.shiftAssignments,
        invalidations: data.invalidations,
        activityRoleTitle: data.activityRoleTitle,
        iconFor,
      }),
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

reportsRouter.get('/team', requireCapability('reports.team.read'), async (req, res, next) => {
  try {
    if (!req.user || !req.scope) return res.status(401).json({ error: 'unauthorized' });
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    const range = resolveReportRange(req.query as Record<string, unknown>, req.scope.workspaceTimezone);
    if ('error' in range) return res.status(range.status).json({ error: range.error, ...(range.extras ?? {}) });
    if (range.days.length > TEAM_REPORT_MAX_DAYS) {
      return res.status(400).json({ error: 'range_too_long', maxDays: TEAM_REPORT_MAX_DAYS });
    }

    const scopedUserIds = req.scope.userIds.filter((id) => id !== req.user!.sub);
    const users = scopedUserIds.length > 0
      ? await prisma.user.findMany({
          where: {
            id: { in: scopedUserIds },
            workspaceId: req.user.ws,
            deactivatedAt: null,
          },
          select: {
            id: true,
            name: true,
            email: true,
            avatarUrl: true,
            activityRoleTitle: true,
            teamId: true,
            team: { select: { name: true } },
          },
          orderBy: [{ name: 'asc' }, { email: 'asc' }],
        })
      : [];
    const reportUsersWithRole: Array<TeamReportUser & { activityRoleTitle: RoleTitle }> = users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      avatarUrl: u.avatarUrl,
      activityRoleTitle: u.activityRoleTitle as RoleTitle,
      teamId: u.teamId,
      teamName: u.team?.name ?? null,
    }));
    const reportUsers: TeamReportUser[] = reportUsersWithRole.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      avatarUrl: user.avatarUrl,
      teamId: user.teamId,
      teamName: user.teamName,
    }));

    const now = new Date();
    const reportData = await loadTeamReportData(reportUsers.map((u) => u.id), range, now);
    const iconFor = await iconForSamples([...reportData.values()].flatMap((d) => d.samples));
    const calendar = await timesheetCalendarInputs({
      workspaceId: req.scope.workspaceId,
      tz: range.tz,
      userIds: reportUsers.map((u) => u.id),
      from: range.from,
      to: range.to,
    });
    const punchFor = await loadPunchLookup({ userIds: reportUsers.map((u) => u.id), from: range.from, to: range.to });
    const overrideFor = await loadOverrideLookup({ userIds: reportUsers.map((u) => u.id), from: range.from, to: range.to });
    const daysByUser = new Map<string, ReturnType<typeof buildMemberReportDays>>();
    for (const user of reportUsersWithRole) {
      const data = reportData.get(user.id) ?? emptyTeamReportData();
      daysByUser.set(user.id, buildMemberReportDays({
        dayStatusFor: calendar.dayStatusFor,
        punchFor,
        overrideFor,
        userId: user.id,
        range,
        now,
        entries: data.entries,
        manualRequests: data.manualRequests,
        samples: data.samples,
        screenshots: data.screenshots,
        evidenceByEntry: data.evidenceByEntry,
        shiftAssignments: data.shiftAssignments,
        invalidations: data.invalidations,
        activityRoleTitle: user.activityRoleTitle,
        iconFor,
      }));
    }

    res.json(buildTeamReportsResponse({ range, users: reportUsers, daysByUser }));
  } catch (err) {
    next(err);
  }
});

reportsRouter.get('/team/summary', requireCapability('reports.team.read'), async (req, res, next) => {
  try {
    if (!req.user || !req.scope) return res.status(401).json({ error: 'unauthorized' });
    const range = resolveReportRange(req.query as Record<string, unknown>, req.scope.workspaceTimezone);
    if ('error' in range) return res.status(range.status).json({ error: range.error, ...(range.extras ?? {}) });
    if (range.days.length > TEAM_REPORT_MAX_DAYS) {
      return res.status(400).json({ error: 'range_too_long', maxDays: TEAM_REPORT_MAX_DAYS });
    }
    const teamId = parseOptionalTeamId(req.query.teamId);
    if ('error' in teamId) return res.status(400).json({ error: teamId.error });

    const scopedUserIds = req.scope.userIds.filter((id) => id !== req.user!.sub);
    const users = scopedUserIds.length > 0
      ? await prisma.user.findMany({
          where: {
            id: { in: scopedUserIds },
            workspaceId: req.user.ws,
            deactivatedAt: null,
            ...(teamId.value ? { teamId: teamId.value } : {}),
          },
          select: {
            id: true,
            name: true,
            email: true,
            avatarUrl: true,
            teamId: true,
            team: { select: { name: true } },
          },
          orderBy: [{ name: 'asc' }, { email: 'asc' }],
        })
      : [];
    const reportUsers: TeamReportUser[] = users.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      avatarUrl: user.avatarUrl,
      teamId: user.teamId,
      teamName: user.team?.name ?? null,
    }));

    const now = new Date();
    const summaryData = await loadTeamReportSummaryData(reportUsers.map((user) => user.id), range, now);
    const calendar = await timesheetCalendarInputs({
      workspaceId: req.scope.workspaceId,
      tz: range.tz,
      userIds: reportUsers.map((user) => user.id),
      from: range.from,
      to: range.to,
    });
    const punchFor = await loadPunchLookup({ userIds: reportUsers.map((user) => user.id), from: range.from, to: range.to });
    const overrideFor = await loadOverrideLookup({ userIds: reportUsers.map((user) => user.id), from: range.from, to: range.to });
    const daysByUser = new Map<string, ReturnType<typeof buildMemberReportDays>>();
    for (const user of reportUsers) {
      const data = summaryData.buckets.get(user.id) ?? emptyTeamReportSummaryData();
      daysByUser.set(user.id, buildMemberReportDays({
        dayStatusFor: calendar.dayStatusFor,
        punchFor,
        overrideFor,
        userId: user.id,
        range,
        now,
        entries: data.entries,
        manualRequests: data.manualRequests,
        samples: [],
        screenshots: [],
        evidenceByEntry: data.evidenceByEntry,
        shiftAssignments: data.shiftAssignments,
        invalidations: data.invalidations,
      }));
    }

    const response: TeamReportsSummaryResponse = buildTeamReportsSummaryResponse({
      range,
      users: reportUsers,
      daysByUser,
      screenshotCountByUser: summaryData.screenshotCountByUser,
    });
    res.json(response);
  } catch (err) {
    next(err);
  }
});

reportsRouter.get('/team/member', requireCapability('reports.team.read'), async (req, res, next) => {
  try {
    if (!req.user || !req.scope) return res.status(401).json({ error: 'unauthorized' });
    const target = await resolveScopedReportUser(req, req.query.userId);
    if (!target.ok) return res.status(target.status).json({ error: target.error });

    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    const range = resolveReportRange(req.query as Record<string, unknown>, req.scope.workspaceTimezone);
    if ('error' in range) return res.status(range.status).json({ error: range.error, ...(range.extras ?? {}) });

    const now = new Date();
    const [profile, reportData, approvals] = await Promise.all([
      loadProfileForUser(target.user.id, req.user.ws),
      loadTeamReportData([target.user.id], range, now),
      loadManualRequestsForUser(target.user.id, range),
    ]);
    if (!profile) return res.status(404).json({ error: 'user_not_found' });
    if ('error' in profile) return res.status(503).json({ error: profile.error });

    const data = reportData.get(target.user.id) ?? emptyTeamReportData();
    const iconFor = await iconForSamples(data.samples);
    const calendar = await timesheetCalendarInputs({
      workspaceId: req.scope.workspaceId,
      tz: range.tz,
      userIds: [target.user.id],
      from: range.from,
      to: range.to,
    });
    const punchFor = await loadPunchLookup({ userIds: [target.user.id], from: range.from, to: range.to });
    const overrideFor = await loadOverrideLookup({ userIds: [target.user.id], from: range.from, to: range.to });
    const days = buildMemberReportDays({
      dayStatusFor: calendar.dayStatusFor,
      punchFor,
      overrideFor,
      userId: target.user.id,
      range,
      now,
      entries: data.entries,
      manualRequests: data.manualRequests,
      samples: data.samples,
      screenshots: data.screenshots,
      evidenceByEntry: data.evidenceByEntry,
      shiftAssignments: data.shiftAssignments,
      invalidations: data.invalidations,
      activityRoleTitle: target.user.activityRoleTitle,
      iconFor,
    });
    const teamReport = buildTeamReportsResponse({
      range,
      users: [target.user],
      daysByUser: new Map([[target.user.id, days]]),
    });
    const member = teamReport.members[0];
    if (!member) return res.status(404).json({ error: 'user_not_found' });

    const response: TeamMemberReportsResponse = {
      from: range.from,
      to: range.to,
      tz: range.tz,
      days: range.days,
      member,
      approvals,
      profile,
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

reportsRouter.get('/team/member/day-apps', requireCapability('reports.team.read'), async (req, res, next) => {
  try {
    if (!req.user || !req.scope) return res.status(401).json({ error: 'unauthorized' });
    const target = await resolveScopedReportUser(req, req.query.userId);
    if (!target.ok) return res.status(target.status).json({ error: target.error });
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    const range = resolveSingleReportDay(req.query as Record<string, unknown>, req.scope.workspaceTimezone);
    if ('error' in range) return res.status(range.status).json({ error: range.error, ...(range.extras ?? {}) });
    const [samples, invalidations] = await Promise.all([
      loadSamples(target.user.id, range),
      loadTimeInvalidationsForUsers([target.user.id], range.rangeStart, range.rangeEnd),
    ]);
    const response: MemberReportDayAppsResponse = buildMemberReportApps({
      userId: target.user.id,
      range,
      samples,
      invalidations,
      iconFor: await iconForSamples(samples),
    });
    res.json(response);
  } catch (err) {
    next(err);
  }
});

reportsRouter.get('/team/member/day-screenshots', requireCapability('reports.team.read'), async (req, res, next) => {
  try {
    if (!req.user || !req.scope) return res.status(401).json({ error: 'unauthorized' });
    const target = await resolveScopedReportUser(req, req.query.userId);
    if (!target.ok) return res.status(target.status).json({ error: target.error });
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    const range = resolveSingleReportDay(req.query as Record<string, unknown>, req.scope.workspaceTimezone);
    if ('error' in range) return res.status(range.status).json({ error: range.error, ...(range.extras ?? {}) });
    const now = new Date();
    const reportData = await loadTeamReportData([target.user.id], range, now);
    const data = reportData.get(target.user.id) ?? emptyTeamReportData();
    const response: MemberReportDayScreenshotsResponse = buildMemberReportScreenshots({
      userId: target.user.id,
      range,
      samples: data.samples,
      screenshots: data.screenshots,
      entries: data.entries,
      evidenceByEntry: data.evidenceByEntry,
      now,
      invalidations: data.invalidations,
      activityRoleTitle: target.user.activityRoleTitle,
      toUrl: screenshotUrl,
    });
    res.json(response);
  } catch (err) {
    next(err);
  }
});

/**
 * Month performance — the monthly attendance grid, as a download.
 *
 * Deliberately export-only: this is the shape HR already reads in the
 * attendance machine's own report, and its job is to leave the browser.
 *
 * Built from the punch record and the Lark-fed Working Calendar only. Scoped
 * by `req.scope.userIds`, so a manager gets their team and an admin gets the
 * workspace. `reports.team.read` because it discloses other people's
 * attendance, which the self-scoped `/me` capability does not cover.
 */
async function monthPerformanceFor(req: Request) {
  if (!req.scope) return { status: 500 as const, error: 'scope_unresolved' };
  const range = resolveReportMonth(req.query as Record<string, unknown>, req.scope.workspaceTimezone);
  if ('error' in range) return { status: 400 as const, error: range.error };
  const report = await loadMonthPerformanceReport({
    workspaceId: req.scope.workspaceId,
    userIds: req.scope.userIds,
    range,
  });
  return { status: 200 as const, report, month: range.month };
}

/**
 * Correct one day's attendance status by hand.
 *
 * Scoped exactly like the report it changes: `reports.team.read` bounded by
 * `req.scope.userIds`, so a manager can correct their own team and an admin the
 * workspace, and nobody can reach a person they cannot already see.
 *
 * The computed answer is snapshotted as the correction is written. That is what
 * lets the report flag a day later on whose ground has moved — approved leave
 * arriving from Lark after somebody marked the day present — instead of
 * silently disagreeing with the calendar.
 */
reportsRouter.put('/attendance-override', requireCapability('reports.team.read'), async (req, res, next) => {
  try {
    if (!req.user || !req.scope) return res.status(401).json({ error: 'unauthorized' });
    const parsed = SetAttendanceOverrideRequest.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
    const { userId, date, code, reason } = parsed.data;
    if (!req.scope.userIds.includes(userId)) return res.status(403).json({ error: 'out_of_scope' });

    const range = resolveReportMonth({ month: date.slice(0, 7) }, req.scope.workspaceTimezone);
    if ('error' in range) return res.status(400).json({ error: range.error });
    const report = await loadMonthPerformanceReport({
      workspaceId: req.scope.workspaceId,
      userIds: [userId],
      range,
    });
    const day = report.rows[0]?.days.find((d) => d.date === date);
    if (!day) return res.status(400).json({ error: 'date_outside_month' });

    // What the report would say without any correction — including this one,
    // if it is being replaced.
    const computedCode = await computeDayCode({
      workspaceId: req.scope.workspaceId,
      userId,
      date,
      tz: range.tz,
      trackedMinutes: day.workMinutes,
    });

    await setAttendanceOverride({
      workspaceId: req.scope.workspaceId,
      userId,
      date,
      code,
      reason,
      setById: req.user.sub,
      computedCode,
    });
    res.json({ ok: true, date, code, computedCode });
  } catch (err) {
    next(err);
  }
});

/** Drop a correction, returning the day to whatever the report computes. */
reportsRouter.delete('/attendance-override', requireCapability('reports.team.read'), async (req, res, next) => {
  try {
    if (!req.user || !req.scope) return res.status(401).json({ error: 'unauthorized' });
    const parsed = ClearAttendanceOverrideRequest.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
    if (!req.scope.userIds.includes(parsed.data.userId)) return res.status(403).json({ error: 'out_of_scope' });
    const cleared = await clearAttendanceOverride(parsed.data);
    res.json({ ok: true, cleared });
  } catch (err) {
    next(err);
  }
});

/**
 * Month pointers — the stored verdict for a month, one row per person.
 *
 * Reads what was last computed. It does not compute on the way out: the point
 * of storing these is that a closed month keeps the verdict it had when it
 * closed, and a GET that quietly recomputed would defeat that.
 *
 * Scoped like every other report: `req.scope.userIds` bounds it, so a manager
 * sees their team and an admin the workspace.
 */
reportsRouter.get('/month-pointers', requireCapability('reports.team.read'), async (req, res, next) => {
  try {
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    const range = resolveReportMonth(req.query as Record<string, unknown>, req.scope.workspaceTimezone);
    if ('error' in range) return res.status(400).json({ error: range.error });

    const stored = await prisma.monthPerformancePointer.findMany({
      where: { month: range.month, userId: { in: req.scope.userIds } },
      include: { user: { select: { name: true, email: true, team: { select: { name: true } } } } },
      orderBy: [{ avgMinutes: 'asc' }],
    });

    res.json({
      month: range.month,
      computedAt: stored[0]?.computedAt?.toISOString() ?? null,
      rows: stored.map((r) => ({
        userId: r.userId,
        name: r.user.name,
        email: r.user.email,
        teamName: r.user.team?.name ?? null,
        band: r.band,
        workedDays: r.workedDays,
        fullDays: r.fullDays,
        halfDays: r.halfDays,
        workMinutes: r.workMinutes,
        avgMinutes: r.avgMinutes,
        fullDaysUnderSix: r.fullDaysUnderSix,
        halfDaysUpToTwo: r.halfDaysUpToTwo,
        fullDaysNineOrMore: r.fullDaysNineOrMore,
        halfDaysOverFive: r.halfDaysOverFive,
        lateDays: r.lateDays,
        lateDaysAfterBuffer: r.lateDaysAfterBuffer,
        earlyDays: r.earlyDays,
        daysWithoutPunch: r.daysWithoutPunch,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Recompute and store a month's pointers.
 *
 * Admin-only, because it overwrites a record other people read. Everything it
 * writes is derived, so re-running it is safe and is the fix for a month whose
 * underlying days have since been corrected.
 */
reportsRouter.post('/month-pointers/recompute', requireCapability('policy.manage'), async (req, res, next) => {
  try {
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    const range = resolveReportMonth(
      { month: (req.body as Record<string, unknown> | undefined)?.month ?? req.query.month },
      req.scope.workspaceTimezone,
    );
    if ('error' in range) return res.status(400).json({ error: range.error });

    const result = await storeMonthPointers({
      workspaceId: req.scope.workspaceId,
      userIds: req.scope.userIds,
      range,
    });
    res.json({ ok: true, month: result.month, written: result.written });
  } catch (err) {
    next(err);
  }
});

/** What the pointers would be right now, without storing them. */
reportsRouter.get('/month-pointers/preview', requireCapability('reports.team.read'), async (req, res, next) => {
  try {
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    const range = resolveReportMonth(req.query as Record<string, unknown>, req.scope.workspaceTimezone);
    if ('error' in range) return res.status(400).json({ error: range.error });
    const rows = await computeMonthPointers({
      workspaceId: req.scope.workspaceId,
      userIds: req.scope.userIds,
      range,
    });
    res.json({ month: range.month, rows });
  } catch (err) {
    next(err);
  }
});

reportsRouter.get('/month-performance.csv', requireCapability('reports.team.read'), async (req, res, next) => {
  try {
    const result = await monthPerformanceFor(req);
    if (result.status !== 200) return res.status(result.status).json({ error: result.error });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="month-performance-${result.month}.csv"`);
    res.send(formatMonthPerformanceCsv(result.report));
  } catch (err) {
    next(err);
  }
});

reportsRouter.get('/month-performance.xlsx', requireCapability('reports.team.read'), async (req, res, next) => {
  try {
    const result = await monthPerformanceFor(req);
    if (result.status !== 200) return res.status(result.status).json({ error: result.error });
    const buffer = await monthPerformanceXlsx(result.report);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="month-performance-${result.month}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

reportsRouter.get('/me/day-apps', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    const range = resolveSingleReportDay(req.query as Record<string, unknown>, req.scope.workspaceTimezone);
    if ('error' in range) return res.status(range.status).json({ error: range.error, ...(range.extras ?? {}) });
    const [samples, invalidations] = await Promise.all([
      loadSamples(req.user.sub, range),
      loadTimeInvalidationsForUsers([req.user.sub], range.rangeStart, range.rangeEnd),
    ]);
    const response: MemberReportDayAppsResponse = buildMemberReportApps({
      userId: req.user.sub,
      range,
      samples,
      invalidations,
      iconFor: await iconForSamples(samples),
    });
    res.json(response);
  } catch (err) {
    next(err);
  }
});

async function resolveScopedReportUser(
  req: Request,
  rawUserId: unknown,
): Promise<
  | { ok: true; user: TeamReportUser & { activityRoleTitle: RoleTitle } }
  | { ok: false; status: 400 | 401 | 403 | 404; error: string }
> {
  if (!req.user || !req.scope) return { ok: false, status: 401, error: 'unauthorized' };
  if (typeof rawUserId !== 'string' || rawUserId.trim().length === 0) {
    return { ok: false, status: 400, error: 'missing_user_id' };
  }
  const userId = rawUserId.trim();
  if (!req.scope.userIds.includes(userId)) {
    return { ok: false, status: 403, error: 'forbidden' };
  }
  const user = await prisma.user.findFirst({
    where: {
      id: userId,
      workspaceId: req.user.ws,
      deactivatedAt: null,
    },
    select: {
      id: true,
      name: true,
      email: true,
      avatarUrl: true,
      activityRoleTitle: true,
      teamId: true,
      team: { select: { name: true } },
    },
  });
  if (!user) return { ok: false, status: 404, error: 'user_not_found' };
  return {
    ok: true,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      avatarUrl: user.avatarUrl,
      activityRoleTitle: user.activityRoleTitle as RoleTitle,
      teamId: user.teamId,
      teamName: user.team?.name ?? null,
    },
  };
}

async function loadManualRequestsForUser(
  userId: string,
  range: ReportRange,
): Promise<ManualTimeRequestDto[]> {
  const rows = await prisma.manualTimeRequest.findMany({
    where: {
      userId,
      requestedStart: { lt: range.rangeEnd },
      requestedEnd: { gt: range.rangeStart },
      status: { in: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] },
    },
    orderBy: [{ requestedStart: 'desc' }, { createdAt: 'desc' }],
    take: 200,
    select: {
      id: true,
      clientUuid: true,
      version: true,
      userId: true,
      approverId: true,
      larkTaskGuid: true,
      taskSummary: true,
      larkMessageId: true,
      larkMessages: { select: { status: true, attempts: true, version: true, createdAt: true } },
      requestedStart: true,
      requestedEnd: true,
      reason: true,
      status: true,
      autoApproved: true,
      decidedAt: true,
      decidedReason: true,
      createdAt: true,
      attendees: { select: { userId: true } },
      user: { select: { id: true, name: true, email: true, avatarUrl: true } },
      approver: { select: { id: true, name: true, email: true, avatarUrl: true } },
    },
  });
  return rows.map((row) => ({
    ...(() => {
      const latest = row.larkMessages.slice().sort((a, b) => b.version - a.version || b.createdAt.getTime() - a.createdAt.getTime())[0];
      const larkDeliveryStatus =
        !latest
          ? row.larkMessageId
            ? 'sent'
            : 'none'
          : ['SENT', 'DECIDED', 'CANCELLED', 'SUPERSEDED'].includes(latest.status)
            ? 'sent'
            : ['SEND_FAILED', 'UPDATE_FAILED'].includes(latest.status)
              ? latest.attempts >= 25
                ? 'failed'
                : 'retrying'
              : 'queued';
      return { larkDeliveryStatus, latestLarkMessageStatus: latest?.status ?? (row.larkMessageId ? 'SENT' : null) };
    })(),
    id: row.id,
    clientUuid: row.clientUuid,
    version: row.version,
    userId: row.userId,
    approverId: row.approverId,
    larkTaskGuid: row.larkTaskGuid,
    taskSummary: row.taskSummary ?? null,
    larkMessageId: row.larkMessageId,
    requestedStart: row.requestedStart.toISOString(),
    requestedEnd: row.requestedEnd.toISOString(),
    reason: row.reason,
    status: row.status,
    autoApproved: row.autoApproved,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    decidedReason: row.decidedReason,
    createdAt: row.createdAt.toISOString(),
    attendeeIds: row.attendees.map((a) => a.userId),
    user: row.user,
    approver: row.approver,
  }));
}

reportsRouter.get('/me/day-screenshots', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    const range = resolveSingleReportDay(req.query as Record<string, unknown>, req.scope.workspaceTimezone);
    if ('error' in range) return res.status(range.status).json({ error: range.error, ...(range.extras ?? {}) });
    const now = new Date();
    const data = await loadReportData(req.user.sub, range, now);
    const response: MemberReportDayScreenshotsResponse = buildMemberReportScreenshots({
      userId: req.user.sub,
      range,
      samples: data.samples,
      screenshots: data.screenshots,
      entries: data.entries,
      evidenceByEntry: data.evidenceByEntry,
      now,
      invalidations: data.invalidations,
      activityRoleTitle: data.activityRoleTitle,
      toUrl: screenshotUrl,
    });
    res.json(response);
  } catch (err) {
    next(err);
  }
});

async function loadReportData(userId: string, range: ReportRange, now = new Date()) {
  const [user, entries, manualRequests, samples, screenshots, shiftAssignments, invalidations] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { activityRoleTitle: true },
    }),
    prisma.timeEntry.findMany({
      where: {
        userId,
        startedAt: { lt: range.rangeEnd },
        OR: [{ endedAt: null }, { endedAt: { gt: range.rangeStart } }],
      },
      select: {
        id: true,
        userId: true,
        source: true,
        larkTaskGuid: true,
        notes: true,
        endedAt: true,
        trackingProtocolVersion: true,
        lastProvenAt: true,
        leaseExpiresAt: true,
        segments: {
          select: { kind: true, startedAt: true, endedAt: true },
          orderBy: { startedAt: 'asc' },
        },
        attendees: { select: { userId: true } },
      },
      orderBy: { startedAt: 'asc' },
    }),
    prisma.manualTimeRequest.findMany({
      where: {
        userId,
        requestedStart: { lt: range.rangeEnd },
        requestedEnd: { gt: range.rangeStart },
        status: { in: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] },
      },
      select: {
        id: true,
        status: true,
        requestedStart: true,
        requestedEnd: true,
        reason: true,
        larkTaskGuid: true,
        decidedReason: true,
        attendees: { select: { userId: true } },
      },
    }),
    loadSamples(userId, range),
    loadScreenshots(userId, range),
    prisma.shiftAssignment.findMany({
      where: {
        userId,
        effectiveFrom: { lt: range.rangeEnd },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: range.rangeStart } }],
      },
      select: {
        shiftId: true,
        effectiveFrom: true,
        effectiveTo: true,
        shiftNameSnapshot: true,
        scheduleSnapshot: true,
        bufferMinSnapshot: true,
      },
      orderBy: { effectiveFrom: 'asc' },
    }),
    loadTimeInvalidationsForUsers([userId], range.rangeStart, range.rangeEnd),
  ]);
  const evidenceByEntry = await loadEntryLiveEvidence(entries, now);
  return {
    activityRoleTitle: (user?.activityRoleTitle ?? 'OTHER') as RoleTitle,
    entries: entries.map((e) => ({
      ...e,
      source: e.source as 'AUTO' | 'MANUAL',
      segments: e.segments.map((s) => ({
        ...s,
        kind: s.kind as 'WORK' | 'MEETING' | 'IDLE_TRIMMED',
      })),
    })),
    manualRequests,
    samples,
    screenshots,
    evidenceByEntry,
    shiftAssignments,
    invalidations,
  };
}

interface TeamReportDataBucket {
  entries: ReportTimeEntry[];
  manualRequests: ReportManualRequest[];
  samples: ReportActivitySample[];
  screenshots: ReportScreenshotRow[];
  shiftAssignments: ReportShiftAssignment[];
  invalidations: TimeInvalidationInput[];
  evidenceByEntry: EntryLiveEvidenceMap;
}

function emptyTeamReportData(): TeamReportDataBucket {
  return {
    entries: [],
    manualRequests: [],
    samples: [],
    screenshots: [],
    shiftAssignments: [],
    invalidations: [],
    evidenceByEntry: new Map(),
  };
}

type TeamReportSummaryDataBucket = Omit<TeamReportDataBucket, 'samples' | 'screenshots'>;

function emptyTeamReportSummaryData(): TeamReportSummaryDataBucket {
  return {
    entries: [],
    manualRequests: [],
    shiftAssignments: [],
    invalidations: [],
    evidenceByEntry: new Map(),
  };
}

async function loadTeamReportSummaryData(
  userIds: string[],
  range: ReportRange,
  now = new Date(),
): Promise<{
  buckets: Map<string, TeamReportSummaryDataBucket>;
  screenshotCountByUser: Map<string, number>;
}> {
  const buckets = new Map<string, TeamReportSummaryDataBucket>();
  for (const userId of userIds) buckets.set(userId, emptyTeamReportSummaryData());
  if (userIds.length === 0) return { buckets, screenshotCountByUser: new Map() };

  const [entries, manualRequests, shiftAssignments, invalidations, screenshotCounts] = await Promise.all([
    prisma.timeEntry.findMany({
      where: {
        userId: { in: userIds },
        startedAt: { lt: range.rangeEnd },
        OR: [{ endedAt: null }, { endedAt: { gt: range.rangeStart } }],
      },
      select: {
        id: true,
        userId: true,
        source: true,
        larkTaskGuid: true,
        notes: true,
        endedAt: true,
        trackingProtocolVersion: true,
        lastProvenAt: true,
        leaseExpiresAt: true,
        segments: {
          select: { kind: true, startedAt: true, endedAt: true },
          orderBy: { startedAt: 'asc' },
        },
        attendees: { select: { userId: true } },
      },
      orderBy: [{ userId: 'asc' }, { startedAt: 'asc' }],
    }),
    prisma.manualTimeRequest.findMany({
      where: {
        userId: { in: userIds },
        requestedStart: { lt: range.rangeEnd },
        requestedEnd: { gt: range.rangeStart },
        status: { in: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] },
      },
      select: {
        userId: true,
        id: true,
        status: true,
        requestedStart: true,
        requestedEnd: true,
        reason: true,
        larkTaskGuid: true,
        decidedReason: true,
        attendees: { select: { userId: true } },
      },
    }),
    prisma.shiftAssignment.findMany({
      where: {
        userId: { in: userIds },
        effectiveFrom: { lt: range.rangeEnd },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: range.rangeStart } }],
      },
      select: {
        userId: true,
        shiftId: true,
        effectiveFrom: true,
        effectiveTo: true,
        shiftNameSnapshot: true,
        scheduleSnapshot: true,
        bufferMinSnapshot: true,
      },
      orderBy: [{ userId: 'asc' }, { effectiveFrom: 'asc' }],
    }),
    loadTimeInvalidationsForUsers(userIds, range.rangeStart, range.rangeEnd),
    prisma.screenshot.groupBy({
      by: ['userId'],
      where: {
        userId: { in: userIds },
        uploadState: 'UPLOADED',
        deletedAt: null,
        capturedAt: { gte: range.rangeStart, lt: range.rangeEnd },
      },
      _count: { _all: true },
    }),
  ]);

  const evidenceByEntry = await loadEntryLiveEvidence(entries, now);
  for (const bucket of buckets.values()) bucket.evidenceByEntry = evidenceByEntry;
  for (const entry of entries) {
    buckets.get(entry.userId)?.entries.push({
      ...entry,
      source: entry.source as 'AUTO' | 'MANUAL',
      segments: entry.segments.map((segment) => ({
        ...segment,
        kind: segment.kind as 'WORK' | 'MEETING' | 'IDLE_TRIMMED',
      })),
    });
  }
  for (const row of manualRequests) {
    const { userId, ...manualRequest } = row;
    buckets.get(userId)?.manualRequests.push(manualRequest);
  }
  for (const row of shiftAssignments) {
    const { userId, ...assignment } = row;
    buckets.get(userId)?.shiftAssignments.push(assignment);
  }
  for (const invalidation of invalidations) buckets.get(invalidation.userId)?.invalidations.push(invalidation);

  return {
    buckets,
    screenshotCountByUser: new Map(screenshotCounts.map((row) => [row.userId, row._count._all])),
  };
}

function parseOptionalTeamId(raw: unknown): { value: string | null } | { error: 'invalid_team_id' } {
  if (raw === undefined) return { value: null };
  if (typeof raw !== 'string') return { error: 'invalid_team_id' };
  const value = raw.trim();
  return value.length > 0 && value.length <= 191 ? { value } : { error: 'invalid_team_id' };
}

async function loadTeamReportData(
  userIds: string[],
  range: ReportRange,
  now = new Date(),
): Promise<Map<string, TeamReportDataBucket>> {
  const grouped = new Map<string, TeamReportDataBucket>();
  for (const userId of userIds) grouped.set(userId, emptyTeamReportData());
  if (userIds.length === 0) return grouped;

  const [entries, manualRequests, samples, screenshots, shiftAssignments, invalidations] = await Promise.all([
    prisma.timeEntry.findMany({
      where: {
        userId: { in: userIds },
        startedAt: { lt: range.rangeEnd },
        OR: [{ endedAt: null }, { endedAt: { gt: range.rangeStart } }],
      },
      select: {
        id: true,
        userId: true,
        source: true,
        larkTaskGuid: true,
        notes: true,
        endedAt: true,
        trackingProtocolVersion: true,
        lastProvenAt: true,
        leaseExpiresAt: true,
        segments: {
          select: { kind: true, startedAt: true, endedAt: true },
          orderBy: { startedAt: 'asc' },
        },
        attendees: { select: { userId: true } },
      },
      orderBy: [{ userId: 'asc' }, { startedAt: 'asc' }],
    }),
    prisma.manualTimeRequest.findMany({
      where: {
        userId: { in: userIds },
        requestedStart: { lt: range.rangeEnd },
        requestedEnd: { gt: range.rangeStart },
        status: { in: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] },
      },
      select: {
        userId: true,
        id: true,
        status: true,
        requestedStart: true,
        requestedEnd: true,
        reason: true,
        larkTaskGuid: true,
        decidedReason: true,
        attendees: { select: { userId: true } },
      },
    }),
    prisma.activitySample.findMany({
      where: {
        userId: { in: userIds },
        bucketStart: { gte: range.rangeStart, lt: range.rangeEnd },
      },
      select: {
        userId: true,
        timeEntryId: true,
        bucketStart: true,
        keystrokes: true,
        clicks: true,
        scrollEvents: true,
        mouseDistancePx: true,
        activeApp: true,
        activeAppBundle: true,
        activeUrl: true,
      },
      orderBy: [{ userId: 'asc' }, { bucketStart: 'asc' }],
    }),
    prisma.screenshot.findMany({
      where: {
        userId: { in: userIds },
        uploadState: 'UPLOADED',
        deletedAt: null,
        capturedAt: { gte: range.rangeStart, lt: range.rangeEnd },
      },
      select: {
        userId: true,
        id: true,
        timeEntryId: true,
        displayId: true,
        capturedAt: true,
        s3Key: true,
        thumbS3Key: true,
        fullUrl: true,
        thumbUrl: true,
        bytes: true,
        width: true,
        height: true,
        blurred: true,
      },
      orderBy: [{ userId: 'asc' }, { capturedAt: 'asc' }],
    }),
    prisma.shiftAssignment.findMany({
      where: {
        userId: { in: userIds },
        effectiveFrom: { lt: range.rangeEnd },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: range.rangeStart } }],
      },
      select: {
        userId: true,
        shiftId: true,
        effectiveFrom: true,
        effectiveTo: true,
        shiftNameSnapshot: true,
        scheduleSnapshot: true,
        bufferMinSnapshot: true,
      },
      orderBy: [{ userId: 'asc' }, { effectiveFrom: 'asc' }],
    }),
    loadTimeInvalidationsForUsers(userIds, range.rangeStart, range.rangeEnd),
  ]);

  const evidenceByEntry = await loadEntryLiveEvidence(entries, now);
  for (const bucket of grouped.values()) bucket.evidenceByEntry = evidenceByEntry;
  for (const entry of entries) {
    grouped.get(entry.userId)?.entries.push({
      ...entry,
      source: entry.source as 'AUTO' | 'MANUAL',
      segments: entry.segments.map((s) => ({
        ...s,
        kind: s.kind as 'WORK' | 'MEETING' | 'IDLE_TRIMMED',
      })),
    });
  }
  for (const row of manualRequests) {
    const { userId, ...request } = row;
    grouped.get(userId)?.manualRequests.push(request);
  }
  for (const row of samples) {
    const { userId, ...sample } = row;
    grouped.get(userId)?.samples.push(sample);
  }
  for (const row of screenshots) {
    const { userId, ...screenshot } = row;
    grouped.get(userId)?.screenshots.push(screenshot);
  }
  for (const row of shiftAssignments) {
    const { userId, ...assignment } = row;
    grouped.get(userId)?.shiftAssignments.push(assignment);
  }
  for (const row of invalidations) {
    grouped.get(row.userId)?.invalidations.push(row);
  }
  return grouped;
}

async function loadSamples(userId: string, range: ReportRange): Promise<ReportActivitySample[]> {
  return prisma.activitySample.findMany({
    where: {
      userId,
      bucketStart: { gte: range.rangeStart, lt: range.rangeEnd },
    },
    select: {
      bucketStart: true,
      timeEntryId: true,
      keystrokes: true,
      clicks: true,
      scrollEvents: true,
      mouseDistancePx: true,
      activeApp: true,
      activeAppBundle: true,
      activeUrl: true,
    },
    orderBy: { bucketStart: 'asc' },
  });
}

async function loadScreenshots(userId: string, range: ReportRange): Promise<ReportScreenshotRow[]> {
  return prisma.screenshot.findMany({
    where: {
      userId,
      uploadState: 'UPLOADED',
      deletedAt: null,
      capturedAt: { gte: range.rangeStart, lt: range.rangeEnd },
    },
    select: {
      id: true,
      timeEntryId: true,
      displayId: true,
      capturedAt: true,
      s3Key: true,
      thumbS3Key: true,
      fullUrl: true,
      thumbUrl: true,
      bytes: true,
      width: true,
      height: true,
      blurred: true,
    },
    orderBy: { capturedAt: 'asc' },
  });
}

function screenshotUrl(row: ReportScreenshotRow, variant: 'full' | 'thumb'): string | null {
  const hasFull = Boolean(row.s3Key || row.fullUrl);
  const hasThumb = Boolean(row.thumbS3Key || row.thumbUrl || hasFull);
  if (variant === 'full' && !hasFull) return null;
  if (variant === 'thumb' && !hasThumb) return null;
  return `/v1/screenshots/${encodeURIComponent(row.id)}/image?variant=${variant}`;
}

export default reportsRouter;
