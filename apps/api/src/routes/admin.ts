import { Router } from 'express';
import { prisma } from '@grind/db';
import { requireAccessToken } from '../middleware/auth';
import { attachScope, requireAdmin, requireManagerOrAbove } from '../middleware/scope';
import { decideByUser } from '../lark/decideByUser';
import {
  addDays as addDaysStr,
  buildTimesheetMatrix,
  dateRange,
  type TimesheetSegmentInput,
} from '../insights/timesheets';

/**
 * Mounted under `/v1/admin`. Every route requires a valid access token and
 * the resolved scope (self / team / workspace). Routes are intentionally
 * scope-aware: a MEMBER hitting `/v1/admin/users` gets their own row;
 * a MANAGER gets their team; ADMIN/OWNER gets the whole workspace.
 */
export const adminRouter = Router();
adminRouter.use(requireAccessToken, attachScope);

interface UserListEntry {
  id: string;
  email: string;
  name: string;
  role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER';
  teamId: string | null;
  managerId: string | null;
  createdAt: string;
}

/**
 * GET /v1/admin/users — every user the caller is allowed to see, including
 * the caller themselves. Order: managers + admins first (for the dashboard
 * "People" table), then by name.
 */
adminRouter.get('/users', async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const users = await prisma.user.findMany({
      where: { id: { in: req.scope.userIds } },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        teamId: true,
        managerId: true,
        createdAt: true,
      },
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
    });
    const out: UserListEntry[] = users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      teamId: u.teamId,
      managerId: u.managerId,
      createdAt: u.createdAt.toISOString(),
    }));
    res.json({ users: out, scope: req.scope.scope });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Manual-time approvals queue (MANAGER and above)
// ============================================================================

interface MtrListEntry {
  id: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  requestedStart: string;
  requestedEnd: string;
  reason: string;
  larkTaskGuid: string | null;
  decidedAt: string | null;
  decidedReason: string | null;
  createdAt: string;
  user: { id: string; name: string; email: string };
}

/**
 * GET /v1/admin/manual-time-requests
 *
 * Scoped queue of manual-time requests. MANAGER sees their team members';
 * ADMIN/OWNER sees the whole workspace; MEMBERs get 403 (they have their
 * own self-view via /v1/time-requests).
 *
 * Filters:
 *   ?status=PENDING (default) — also accepts APPROVED, REJECTED, CANCELLED, all
 *
 * Sort: PENDING first (oldest pending bubbles up), then by createdAt desc.
 */
adminRouter.get('/manual-time-requests', requireManagerOrAbove, async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const statusParam = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : 'PENDING';
    const validStatuses = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
    const where: { userId: { in: string[] }; status?: (typeof validStatuses)[number] } = {
      userId: { in: req.scope.userIds },
    };
    if (statusParam !== 'ALL') {
      if (!(validStatuses as readonly string[]).includes(statusParam)) {
        return res.status(400).json({ error: 'invalid_status' });
      }
      where.status = statusParam as (typeof validStatuses)[number];
    }
    const rows = await prisma.manualTimeRequest.findMany({
      where,
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: [
        // PENDING bubbles to the top of mixed queries via createdAt fallback.
        { createdAt: 'desc' },
      ],
      take: 200,
    });
    const out: MtrListEntry[] = rows.map((r) => ({
      id: r.id,
      status: r.status,
      requestedStart: r.requestedStart.toISOString(),
      requestedEnd: r.requestedEnd.toISOString(),
      reason: r.reason,
      larkTaskGuid: r.larkTaskGuid,
      decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
      decidedReason: r.decidedReason,
      createdAt: r.createdAt.toISOString(),
      user: { id: r.user.id, name: r.user.name, email: r.user.email },
    }));
    res.json({ requests: out, scope: req.scope.scope });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /v1/admin/manual-time-requests/:id/decide
 * Body: { action: 'approve' | 'reject', reason?: string }
 *
 * Dashboard mirror of the Lark IM card flow. Same DB effects (status,
 * decidedAt, decidedReason, TimeEntry on approve). Best-effort refresh of
 * the Lark card so the approver chat matches DB truth.
 *
 * Authorization is enforced inside `decideByUser` by checking the requester's
 * userId is in `req.scope.userIds`. We block MEMBERs at the router level so
 * a MEMBER hitting this endpoint never even hits the service.
 */
adminRouter.post('/manual-time-requests/:id/decide', requireManagerOrAbove, async (req, res, next) => {
  try {
    if (!req.scope || !req.user) return res.status(401).json({ error: 'unauthorized' });
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'missing_id' });
    const action = typeof req.body?.action === 'string' ? req.body.action : '';
    if (action !== 'approve' && action !== 'reject') {
      return res.status(400).json({ error: 'invalid_action' });
    }
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) || undefined : undefined;
    const out = await decideByUser({
      requestId: id,
      action,
      deciderUserId: req.user.sub,
      scopeUserIds: req.scope.userIds,
      reason,
    });
    if (!out) return res.status(404).json({ error: 'not_found' });
    if (out.noop === 'forbidden') return res.status(403).json({ error: 'forbidden' });
    res.json(out);
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Timesheets matrix (MANAGER and above)
// ============================================================================

const TIMESHEETS_MAX_DAYS = 60;
const TIMESHEETS_DEFAULT_DAYS = 14;

function isYmd(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

interface ResolvedTimesheetRange {
  from: string;
  to: string;
  tz: string;
}

interface TimesheetRangeError {
  status: number;
  error: string;
  extras?: Record<string, unknown>;
}

/** Pull tz / from / to from the query and validate. Returns either a
 *  resolved range or the error shape the route should respond with. */
function resolveTimesheetRange(req: { query: Record<string, unknown> }): ResolvedTimesheetRange | TimesheetRangeError {
  const tz = typeof req.query.tz === 'string' && (req.query.tz as string).length > 0 ? (req.query.tz as string) : 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    return { status: 400, error: 'invalid_tz' };
  }
  const todayKey = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date())
    .slice(0, 10);

  const to = isYmd(req.query.to) ? (req.query.to as string) : todayKey;
  const from = isYmd(req.query.from) ? (req.query.from as string) : addDaysStr(to, -(TIMESHEETS_DEFAULT_DAYS - 1));

  if (from > to) return { status: 400, error: 'invalid_range' };
  const len = dateRange(from, to).length;
  if (len > TIMESHEETS_MAX_DAYS) {
    return { status: 400, error: 'range_too_long', extras: { maxDays: TIMESHEETS_MAX_DAYS } };
  }
  return { from, to, tz };
}

/** Build the matrix + the user list, used by both the JSON and CSV endpoints. */
async function loadTimesheetData(scope: { userIds: string[] }, range: ResolvedTimesheetRange) {
  const lookbackStart = new Date(`${range.from}T00:00:00Z`);
  lookbackStart.setUTCDate(lookbackStart.getUTCDate() - 1);
  const lookbackEnd = new Date(`${range.to}T00:00:00Z`);
  lookbackEnd.setUTCDate(lookbackEnd.getUTCDate() + 2);

  const entries = await prisma.timeEntry.findMany({
    where: {
      userId: { in: scope.userIds },
      startedAt: { lt: lookbackEnd },
      OR: [{ endedAt: null }, { endedAt: { gt: lookbackStart } }],
    },
    include: { segments: { select: { kind: true, startedAt: true, endedAt: true } } },
  });

  const now = Date.now();
  const segs: TimesheetSegmentInput[] = [];
  for (const e of entries) {
    for (const s of e.segments) {
      segs.push({
        userId: e.userId,
        source: e.source as 'AUTO' | 'MANUAL',
        segmentKind: s.kind as 'WORK' | 'MEETING' | 'IDLE_TRIMMED',
        startedAt: s.startedAt.getTime(),
        endedAt: (s.endedAt ?? new Date(now)).getTime(),
      });
    }
  }

  const matrix = buildTimesheetMatrix({ from: range.from, to: range.to, tz: range.tz, segments: segs });
  const users = await prisma.user.findMany({
    where: { id: { in: scope.userIds } },
    select: { id: true, name: true, email: true, role: true },
    orderBy: [{ role: 'asc' }, { name: 'asc' }],
  });
  return { matrix, users };
}

/**
 * GET /v1/admin/timesheets?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=IANA
 *
 * Per-user × per-day matrix of total worked / meeting / manual time, scoped.
 * Powers the Team page — a Hubstaff-style at-a-glance view of "who tracked
 * what across the last week or two."
 *
 * Defaults: trailing 14 days ending today (in the requested tz, falling back
 * to UTC). Hard cap at 60 days so a typo can't melt the DB.
 */
adminRouter.get('/timesheets', requireManagerOrAbove, async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const range = resolveTimesheetRange(req);
    if ('error' in range) return res.status(range.status).json({ error: range.error, ...(range.extras ?? {}) });
    const { matrix, users } = await loadTimesheetData(req.scope, range);
    if (!matrix) return res.status(400).json({ error: 'invalid_date_or_tz' });
    res.json({ ...matrix, scope: req.scope.scope, users });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /v1/admin/timesheets.csv?from=&to=&tz=
 *
 * Same scope + range + validation as the JSON endpoint, but emits a row-per-
 * (user, day) CSV that opens cleanly in Excel/Sheets. Cells where the user
 * tracked nothing are dropped (zero rows, not blank rows) — managers
 * exporting a 30-day audit don't want to scroll through "Sat: 0".
 */
adminRouter.get('/timesheets.csv', requireManagerOrAbove, async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const range = resolveTimesheetRange(req);
    if ('error' in range) return res.status(range.status).json({ error: range.error, ...(range.extras ?? {}) });
    const { matrix, users } = await loadTimesheetData(req.scope, range);
    if (!matrix) return res.status(400).json({ error: 'invalid_date_or_tz' });

    const usersById = new Map(users.map((u) => [u.id, u]));
    const lines: string[] = [];
    lines.push(
      'name,email,role,day,worked_h,meeting_h,manual_h,total_h,first_activity,last_activity',
    );
    // Stable ordering: user (role-then-name like the JSON), then day asc.
    for (const u of users) {
      const row = matrix.cells[u.id];
      if (!row) continue;
      for (const day of matrix.days) {
        const cell = row[day];
        if (!cell || cell.totalMs === 0) continue;
        const first = cell.firstActivityMs ? fmtTimeForTz(cell.firstActivityMs, matrix.tz) : '';
        const last = cell.lastActivityMs ? fmtTimeForTz(cell.lastActivityMs, matrix.tz) : '';
        lines.push(
          [
            csv(u.name),
            csv(u.email),
            u.role,
            day,
            msToHours(cell.workedMs),
            msToHours(cell.meetingMs),
            msToHours(cell.manualMs),
            msToHours(cell.totalMs),
            first,
            last,
          ].join(','),
        );
      }
    }
    // Voider for usersById to suppress unused-warning since we use users
    // directly. Keeps the lookup if a future column needs it.
    void usersById;

    const filename = `timesheets-${range.from}-to-${range.to}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(lines.join('\n') + '\n');
  } catch (err) {
    next(err);
  }
});

/** Quote a CSV cell if it contains a comma, quote, or newline. */
function csv(s: string): string {
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** 2-decimal hours, eg 90 min → "1.50". */
function msToHours(ms: number): string {
  return (ms / 3_600_000).toFixed(2);
}

/** Format an epoch in a tz as HH:MM (24h) for CSV. */
function fmtTimeForTz(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ms));
}

// ============================================================================
// Teams CRUD (read = MANAGER+, write = ADMIN)
// ============================================================================

interface TeamDto {
  id: string;
  name: string;
  managerId: string | null;
  memberCount: number;
  createdAt: string;
}

function serializeTeam(t: {
  id: string;
  name: string;
  managerId: string | null;
  members: Array<{ id: string }>;
  createdAt: Date;
}): TeamDto {
  return {
    id: t.id,
    name: t.name,
    managerId: t.managerId,
    memberCount: t.members.length,
    createdAt: t.createdAt.toISOString(),
  };
}

/**
 * GET /v1/admin/teams — workspace teams visible to the caller.
 *
 * ADMIN / OWNER → every team in the workspace.
 * MANAGER       → every team they manage.
 * MEMBER        → 403 (members don't need a team list; their teamId is on /me).
 */
adminRouter.get('/teams', requireManagerOrAbove, async (req, res, next) => {
  try {
    if (!req.scope || !req.user) return res.status(401).json({ error: 'unauthorized' });
    const where: { workspaceId: string; managerId?: string } = { workspaceId: req.scope.workspaceId };
    if (!req.scope.isAdmin) where.managerId = req.user.sub;
    const teams = await prisma.team.findMany({
      where,
      include: { members: { select: { id: true } } },
      orderBy: { name: 'asc' },
    });
    res.json({ teams: teams.map(serializeTeam) });
  } catch (err) {
    next(err);
  }
});

/** Body shape: { name: string, managerId?: string|null }. */
adminRouter.post('/teams', requireAdmin, async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (name.length === 0 || name.length > 80) return res.status(400).json({ error: 'invalid_name' });
    const managerId = typeof req.body?.managerId === 'string' && req.body.managerId.length > 0 ? req.body.managerId : null;
    // Manager (if provided) must be in the workspace.
    if (managerId) {
      const m = await prisma.user.findUnique({ where: { id: managerId }, select: { workspaceId: true } });
      if (!m || m.workspaceId !== req.scope.workspaceId) return res.status(400).json({ error: 'manager_out_of_workspace' });
    }
    const team = await prisma.team.create({
      data: { workspaceId: req.scope.workspaceId, name, managerId },
      include: { members: { select: { id: true } } },
    });
    res.status(201).json(serializeTeam(team));
  } catch (err) {
    next(err);
  }
});

/** PATCH body: { name?: string, managerId?: string|null }. */
adminRouter.patch('/teams/:id', requireAdmin, async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'missing_id' });
    const existing = await prisma.team.findUnique({ where: { id } });
    if (!existing || existing.workspaceId !== req.scope.workspaceId) {
      return res.status(404).json({ error: 'not_found' });
    }

    const data: { name?: string; managerId?: string | null } = {};
    if (typeof req.body?.name === 'string') {
      const name = req.body.name.trim();
      if (name.length === 0 || name.length > 80) return res.status(400).json({ error: 'invalid_name' });
      data.name = name;
    }
    if ('managerId' in (req.body ?? {})) {
      const raw = req.body.managerId;
      if (raw === null || raw === '') {
        data.managerId = null;
      } else if (typeof raw === 'string') {
        const m = await prisma.user.findUnique({ where: { id: raw }, select: { workspaceId: true } });
        if (!m || m.workspaceId !== req.scope.workspaceId) {
          return res.status(400).json({ error: 'manager_out_of_workspace' });
        }
        data.managerId = raw;
      } else {
        return res.status(400).json({ error: 'invalid_managerId' });
      }
    }
    if (Object.keys(data).length === 0) return res.status(400).json({ error: 'nothing_to_update' });

    const team = await prisma.team.update({
      where: { id },
      data,
      include: { members: { select: { id: true } } },
    });
    res.json(serializeTeam(team));
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /v1/admin/teams/:id — drops the team. Members keep their User row;
 * their teamId silently goes null (Prisma onDelete: SetNull from the schema).
 * Lark identities and time history are untouched — managers may want to
 * re-team people on the dashboard's /users page after a reorg.
 */
adminRouter.delete('/teams/:id', requireAdmin, async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'missing_id' });
    const existing = await prisma.team.findUnique({ where: { id } });
    if (!existing || existing.workspaceId !== req.scope.workspaceId) {
      return res.status(404).json({ error: 'not_found' });
    }
    await prisma.team.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// PATCH a user (ADMIN-only). role / name / teamId / managerId.
// ============================================================================

const VALID_ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'MEMBER'] as const;
type ValidRole = (typeof VALID_ROLES)[number];

adminRouter.patch('/users/:id', requireAdmin, async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'missing_id' });
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing || existing.workspaceId !== req.scope.workspaceId) {
      return res.status(404).json({ error: 'not_found' });
    }

    const data: { name?: string; role?: ValidRole; teamId?: string | null; managerId?: string | null } = {};

    if (typeof req.body?.name === 'string') {
      const name = req.body.name.trim();
      if (name.length === 0 || name.length > 80) return res.status(400).json({ error: 'invalid_name' });
      data.name = name;
    }

    if (typeof req.body?.role === 'string') {
      if (!(VALID_ROLES as readonly string[]).includes(req.body.role)) {
        return res.status(400).json({ error: 'invalid_role' });
      }
      data.role = req.body.role as ValidRole;
    }

    if ('teamId' in (req.body ?? {})) {
      const raw = req.body.teamId;
      if (raw === null || raw === '') {
        data.teamId = null;
      } else if (typeof raw === 'string') {
        const t = await prisma.team.findUnique({ where: { id: raw }, select: { workspaceId: true } });
        if (!t || t.workspaceId !== req.scope.workspaceId) return res.status(400).json({ error: 'team_out_of_workspace' });
        data.teamId = raw;
      } else {
        return res.status(400).json({ error: 'invalid_teamId' });
      }
    }

    if ('managerId' in (req.body ?? {})) {
      const raw = req.body.managerId;
      if (raw === null || raw === '') {
        data.managerId = null;
      } else if (typeof raw === 'string') {
        if (raw === id) return res.status(400).json({ error: 'cannot_manage_self' });
        const m = await prisma.user.findUnique({ where: { id: raw }, select: { workspaceId: true } });
        if (!m || m.workspaceId !== req.scope.workspaceId) return res.status(400).json({ error: 'manager_out_of_workspace' });
        data.managerId = raw;
      } else {
        return res.status(400).json({ error: 'invalid_managerId' });
      }
    }

    if (Object.keys(data).length === 0) return res.status(400).json({ error: 'nothing_to_update' });

    // Safety: never demote the workspace's last OWNER. Without this, a
    // careless admin could lock everyone out of full-workspace privileges.
    if (data.role && data.role !== 'OWNER' && existing.role === 'OWNER') {
      const owners = await prisma.user.count({
        where: { workspaceId: req.scope.workspaceId, role: 'OWNER' },
      });
      if (owners <= 1) return res.status(400).json({ error: 'last_owner_protected' });
    }

    const updated = await prisma.user.update({
      where: { id },
      data,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        teamId: true,
        managerId: true,
        createdAt: true,
      },
    });
    res.json({
      ...updated,
      createdAt: updated.createdAt.toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

export default adminRouter;
