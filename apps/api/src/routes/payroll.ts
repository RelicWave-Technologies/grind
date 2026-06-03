import { Router } from 'express';
import { prisma } from '@grind/db';
import { requireAccessToken } from '../middleware/auth';
import { attachScope } from '../middleware/scope';
import {
  buildTimesheetMatrix,
  type TimesheetSegmentInput,
} from '../insights/timesheets';
import {
  buildMonthlyPayroll,
  formatPayrollCsv,
  type PayrollUserMeta,
} from '../payroll/monthly';

/**
 * Monthly payroll worksheet (M15). ADMIN-only — sums tracked time per
 * user over a calendar month and returns either JSON (for the
 * dashboard preview) or CSV (for finance handoff).
 *
 * The exact format is documented in `payroll/monthly.ts` and was
 * deliberately kept conservative pending the "discuss with finance +
 * Vijay sir" follow-up. Columns are easy to add — just extend
 * formatPayrollCsv and the route response shape.
 */
export const payrollRouter = Router();
payrollRouter.use(requireAccessToken, attachScope);

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

interface ResolvedMonth {
  month: string;
  from: string; // YYYY-MM-01
  to: string; // last day of month
  tz: string;
}

function isMonth(v: unknown): v is string {
  return typeof v === 'string' && MONTH_RE.test(v);
}

function lastDayOfMonth(year: number, monthIndex0: number): number {
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
}

function resolveMonth(req: { query: Record<string, unknown> }): ResolvedMonth | { error: string } {
  const tz = typeof req.query.tz === 'string' && req.query.tz.length > 0 ? req.query.tz : 'UTC';
  let month: string;
  if (isMonth(req.query.month)) {
    month = req.query.month;
  } else if (req.query.month == null) {
    // Default: current month in the requested tz.
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' });
    month = fmt.format(new Date()).slice(0, 7);
  } else {
    return { error: 'invalid_month' };
  }
  const [y, m] = month.split('-').map((n) => Number.parseInt(n, 10));
  if (!y || !m) return { error: 'invalid_month' };
  const from = `${month}-01`;
  const last = lastDayOfMonth(y, m - 1);
  const to = `${month}-${String(last).padStart(2, '0')}`;
  return { month, from, to, tz };
}

async function buildPayrollPayload(
  workspaceId: string,
  range: ResolvedMonth,
) {
  // Pull every user in the workspace with their team, then their
  // segments over the month window (with a 1-day lookback/forward
  // cushion so segments spanning the month boundary are clipped
  // correctly by buildTimesheetMatrix).
  const users = await prisma.user.findMany({
    where: { workspaceId },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      teamId: true,
      team: { select: { name: true } },
    },
    orderBy: [{ role: 'asc' }, { name: 'asc' }],
  });

  const meta: PayrollUserMeta[] = users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    teamId: u.teamId,
    teamName: u.team?.name ?? null,
  }));

  const userIds = users.map((u) => u.id);
  const lookbackStart = new Date(`${range.from}T00:00:00Z`);
  lookbackStart.setUTCDate(lookbackStart.getUTCDate() - 1);
  const lookbackEnd = new Date(`${range.to}T00:00:00Z`);
  lookbackEnd.setUTCDate(lookbackEnd.getUTCDate() + 2);

  const entries =
    userIds.length === 0
      ? []
      : await prisma.timeEntry.findMany({
          where: {
            userId: { in: userIds },
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
  if (!matrix) return { error: 'invalid_date_or_tz' as const };

  const payroll = buildMonthlyPayroll(
    { month: range.month, tz: range.tz, matrix, users: meta },
    now,
  );
  return { payroll };
}

payrollRouter.get('/monthly', async (req, res, next) => {
  try {
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    if (!req.scope.isAdmin) return res.status(403).json({ error: 'admin_only' });
    const range = resolveMonth(req);
    if ('error' in range) return res.status(400).json({ error: range.error });
    const result = await buildPayrollPayload(req.scope.workspaceId, range);
    if ('error' in result) return res.status(400).json({ error: result.error });
    res.json(result.payroll);
  } catch (err) {
    next(err);
  }
});

payrollRouter.get('/monthly.csv', async (req, res, next) => {
  try {
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    if (!req.scope.isAdmin) return res.status(403).json({ error: 'admin_only' });
    const range = resolveMonth(req);
    if ('error' in range) return res.status(400).json({ error: range.error });
    const result = await buildPayrollPayload(req.scope.workspaceId, range);
    if ('error' in result) return res.status(400).json({ error: result.error });
    const csv = formatPayrollCsv(result.payroll);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="grind-payroll-${range.month}.csv"`,
    );
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

export default payrollRouter;
