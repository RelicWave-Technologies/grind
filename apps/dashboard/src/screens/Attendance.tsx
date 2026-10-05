import './attendance.css';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouteContext } from '@tanstack/react-router';
import { CalendarRange, FileSpreadsheet, Sheet } from 'lucide-react';
import { api, ApiError, API_BASE } from '../lib/api';
import { useMonthReportDownload, fmtMonthLong } from '../lib/useMonthReportDownload';
import type { TimesheetMatrix } from '../lib/types';
import type { MonthSummaryResponse, MonthSummaryRow } from '@grind/types';
import type { LeaveBalanceRow, LeaveBalancesResponse } from '../lib/types';
import { EditMemberModal } from './Calendar';
import { fmtTime, fmtDurationMs, fmtDayLabel, addDays, todayKey } from '../lib/format';
import {
  Tabs,
  Page,
  PageHeader,
  Toolbar,
  Banner,
  Segmented,
  DateStepper,
  Button,
  Card,
  StatRow,
  Stat,
  Table,
  THead,
  Tbody,
  Tr,
  Th,
  Td,
  Identity,
  Avatar,
  Tag,
  EmptyState,
  SkeletonTable,
  Modal,
} from '../ui';

const SCOPE_LABEL: Record<TimesheetMatrix['scope'], string> = {
  self: 'Just you',
  team: 'Your team',
  workspace: 'Entire workspace',
};

const RANGES: Array<{ key: '7' | '14' | '30'; label: string; days: number }> = [
  { key: '7', label: '7d', days: 7 },
  { key: '14', label: '14d', days: 14 },
  { key: '30', label: '30d', days: 30 },
];

/** A user-day is "present" when they tracked at least PRESENT_MIN_MS. */
const PRESENT_MIN_MS = 30 * 60 * 1000;

/**
 * Attendance — the same scoped /v1/admin/timesheets data as /team, recast as a
 * present/absent matrix (people × days) with first/last activity times and a
 * per-person present count.
 *
 * Composed entirely from the shared "Quiet Datasheet" kit (PageHeader, Toolbar,
 * Stat, Table, Identity, Tag, Banner, EmptyState, …): one header, a flush KPI
 * StatRow, and one sticky datasheet Table where each user-day shows mono
 * first → last times and a present count rail. No bespoke colour, type, or
 * component styling — tokens and kit primitives only.
 *
 * Presentation only — the query, scope label, ranges, date-nav, present/absent
 * threshold, first/last computation, CSV href, and all states are unchanged.
 */
export function AttendanceScreen() {
  const { me } = useRouteContext({ from: '/authed' });
  const tz = me.workspaceTimezone;

  const [anchor, setAnchor] = useState<string>(() => todayKey(tz));
  const [rangeKey, setRangeKey] = useState<'7' | '14' | '30'>('14');
  const days = RANGES.find((r) => r.key === rangeKey)!.days;
  const from = addDays(anchor, -(days - 1));

  const q = useQuery({
    queryKey: ['admin', 'attendance', from, anchor, tz],
    queryFn: () => {
      const params = new URLSearchParams({ from, to: anchor, tz });
      return api<TimesheetMatrix>(`/v1/admin/timesheets?${params.toString()}`);
    },
  });

  function csvUrl(): string {
    const params = new URLSearchParams({ from, to: anchor, tz });
    return `${API_BASE}/v1/admin/timesheets.csv?${params.toString()}`;
  }

  /**
   * The month performance report — the monthly attendance grid HR reads, with
   * punch in / punch out, worked hours and a status code per day.
   *
   * Always a WHOLE month, taken from the month the anchor sits in, because the
   * report's own header says "Report Month" and a 14-day slice of one is not a
   * thing anyone can file. It ignores the range selector above deliberately.
   */
  // Two views, one at a time: the month as HR closes it (default), and the
  // day-by-day activity grid.
  const [view, setView] = useState<'month' | 'daily'>('month');
  const [reportMonth, setReportMonth] = useState<string>(() => todayKey(tz).slice(0, 7));
  const thisMonth = todayKey(tz).slice(0, 7);
  const monthReport = useMonthReportDownload();

  const isToday = anchor === todayKey(tz);
  const today = todayKey(tz);
  const tzLabel = tz.replace(/_/g, ' ');
  const data = q.data;
  const hasPeople = !!data && data.users.length > 0;

  const subtitle =
    view === 'month'
      ? 'Each person’s month — the same numbers as the Excel.'
      : data
        ? `${SCOPE_LABEL[data.scope]} — first and last activity across ${data.days.length} days.`
        : 'Assembling the attendance matrix…';

  return (
    <Page>
      <PageHeader
        eyebrow={`Attendance · ${tzLabel}`}
        title="Attendance"
        subtitle={subtitle}
        actions={
          view === 'month' ? (
          <Toolbar>
            <DateStepper
              value={fmtMonthLong(reportMonth)}
              onPrev={() => setReportMonth((m) => shiftMonth(m, -1))}
              onNext={() => setReportMonth((m) => shiftMonth(m, 1))}
              nextDisabled={reportMonth >= thisMonth}
              prevLabel="Previous month"
              nextLabel="Next month"
            />
            <Button
              variant="secondary"
              icon={<FileSpreadsheet size={14} strokeWidth={2} />}
              loading={monthReport.downloading === 'xlsx'}
              disabled={monthReport.downloading !== null}
              onClick={() => void monthReport.download(reportMonth, 'xlsx')}
            >
              Excel
            </Button>
            <Button
              variant="secondary"
              icon={<Sheet size={14} strokeWidth={2} />}
              loading={monthReport.downloading === 'csv'}
              disabled={monthReport.downloading !== null}
              onClick={() => void monthReport.download(reportMonth, 'csv')}
            >
              CSV
            </Button>
          </Toolbar>
          ) : (
          <Toolbar>
            <Segmented
              value={rangeKey}
              onChange={(v) => setRangeKey(v as '7' | '14' | '30')}
              items={RANGES.map((r) => ({ value: r.key, label: r.label }))}
            />
            <DateStepper
              value={isToday ? 'Today' : fmtDayLabel(anchor, tz)}
              onPrev={() => setAnchor((d) => addDays(d, -days))}
              onNext={() => setAnchor((d) => addDays(d, days))}
              nextDisabled={isToday}
              prevLabel="Previous range"
              nextLabel="Next range"
            />
            <a className="ui-btn ui-btn--primary ui-btn--md" href={csvUrl()} download>
              <span className="ui-btn__icon">
                <CalendarRange size={14} strokeWidth={2} />
              </span>
              <span className="ui-btn__label">Export CSV</span>
            </a>
          </Toolbar>
          )
        }
      />

      <Tabs
        items={[
          { value: 'month' as const, label: 'Month summary' },
          { value: 'daily' as const, label: 'Daily' },
        ]}
        value={view}
        onChange={setView}
      />

      {monthReport.error && <Banner status="danger">{monthReport.error}</Banner>}

      {view === 'month' && <MonthSummary month={reportMonth} isAdmin={me.role === 'ADMIN'} />}

      {view === 'daily' && hasPeople && <AttendanceSummary data={data!} timeZone={tz} />}

      {view === 'daily' && (
      <Card variant="flush" className="atd-card">
        {q.isLoading ? (
          <SkeletonTable rows={6} />
        ) : q.isError ? (
          <EmptyState
            tone="danger"
            title="Couldn’t load attendance"
            description={(q.error as Error).message}
            action={
              <Button variant="soft" onClick={() => q.refetch()}>
                Try again
              </Button>
            }
          />
        ) : !hasPeople ? (
          <EmptyState
            title="No people in scope"
            description="There’s no one to show for this date range."
          />
        ) : (
          <>
            <div className="atd-card-head">
              <div>
                <h2 className="ui-t-title">Attendance</h2>
                <p className="ui-t-small">Present means at least 30m tracked in the local day.</p>
              </div>
              <div className="atd-legend">
                <Tag status="success" dot>
                  Present
                </Tag>
                <Tag status="warn" dot>
                  Needs review
                </Tag>
                <Tag status="neutral" dot>
                  Absent · under 30m
                </Tag>
              </div>
            </div>
            <div className="atd-scroll">
              <Table density="compact" stickyHead stickyCol className="atd-table">
                <colgroup>
                  <col className="atd-col-person" />
                  {data!.days.map((d) => (
                    <col key={d} className="atd-col-day" />
                  ))}
                  <col className="atd-col-present" />
                </colgroup>
                <THead>
                  <Tr>
                    <Th className="atd-col-person">Person</Th>
                    {data!.days.map((d) => {
                      const date = new Date(`${d}T00:00:00`);
                      const dow = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(date);
                      const dnum = new Intl.DateTimeFormat(undefined, { day: 'numeric' }).format(date);
                      return (
                        <Th key={d} className="atd-col-day" align="center">
                          <span className="atd-dayhead">
                            <span className="atd-dayhead__dow">{dow}</span>
                            <span className="ui-mono atd-dayhead__num">{dnum}</span>
                            {d === today && (
                              <Tag status="neutral" mono className="atd-today-tag">
                                Today
                              </Tag>
                            )}
                          </span>
                        </Th>
                      );
                    })}
                    <Th className="atd-col-present" align="center">Present</Th>
                  </Tr>
                </THead>
                <Tbody>
                  {data!.users.map((u) => {
                    const row = data!.cells[u.id] ?? {};
                    const total = data!.days.length;
                    const daysPresent = data!.days.filter(
                      (d) => (row[d]?.totalMs ?? 0) >= PRESENT_MIN_MS,
                    ).length;
                    const daysNeedingReview = data!.days.filter((d) => cellNeedsReview(row[d])).length;
                    const pct = total > 0 ? Math.round((daysPresent / total) * 100) : 0;
                    return (
                      <Tr key={u.id}>
                        <Td className="atd-col-person">
                          <Identity
                            name={u.name}
                            subtitle={u.role.toLowerCase()}
                            avatar={<Avatar name={u.name} src={u.avatarUrl ?? undefined} size={32} />}
                          />
                        </Td>
                        {data!.days.map((d) => {
                          const cell = row[d];
                          const present = cell ? cell.totalMs >= PRESENT_MIN_MS : false;
                          const needsReview = cellNeedsReview(cell);
                          const first = cell?.firstActivityMs ? fmtTime(cell.firstActivityMs, tz) : '—';
                          const last = cell?.lastActivityMs ? fmtTime(cell.lastActivityMs, tz) : '—';
                          return (
                            <Td key={d} className="atd-col-day" align="center">
                              {present ? (
                                <span className={`atd-cell ${needsReview ? 'atd-cell--review' : 'atd-cell--present'}`}>
                                  <span className="ui-mono atd-cell__times">
                                    <span className="atd-cell__time">{first}</span>
                                    <span className="atd-cell__arrow"> → </span>
                                    <span className="atd-cell__time">{last}</span>
                                  </span>
                                  <span className="ui-mono atd-cell__dur">
                                    {fmtDurationMs(cell!.totalMs)}
                                  </span>
                                  {needsReview && <span className="atd-cell__evidence">No samples</span>}
                                </span>
                              ) : (
                                <span className="ui-mono atd-cell__absent" aria-label="Absent">
                                  –
                                </span>
                              )}
                            </Td>
                          );
                        })}
                        <Td className="atd-col-present" align="center">
                          <span className="atd-present">
                            <span className="ui-mono atd-present__count">
                              {daysPresent}
                              <span className="atd-present__of">/{total}</span>
                            </span>
                            <Tag status={daysNeedingReview > 0 ? 'warn' : pct >= 80 ? 'success' : pct >= 40 ? 'warn' : 'neutral'} mono>
                              {pct}%
                            </Tag>
                          </span>
                        </Td>
                      </Tr>
                    );
                  })}
                </Tbody>
              </Table>
            </div>
          </>
        )}
      </Card>
      )}
    </Page>
  );
}

function cellNeedsReview(
  cell: { totalMs: number; workedMs: number; meetingMs: number; activitySampleCount: number } | undefined,
): boolean {
  return !!cell && cell.totalMs >= PRESENT_MIN_MS && autoTrackedMs(cell) > 0 && cell.activitySampleCount === 0;
}

function autoTrackedMs(cell: { workedMs: number; meetingMs: number }): number {
  return cell.workedMs + cell.meetingMs;
}

/**
 * KPI strip: present-rate across the whole matrix, head-count, the number of
 * people present every day, and the day span. Derived from the same
 * cells/days/threshold — read-only, presentation only.
 */
function AttendanceSummary({ data, timeZone }: { data: TimesheetMatrix; timeZone: string }) {
  const total = data.users.length;
  const dayCount = data.days.length;
  const slots = total * dayCount;

  let presentSlots = 0;
  let perfect = 0;
  for (const u of data.users) {
    const row = data.cells[u.id] ?? {};
    let here = 0;
    for (const d of data.days) {
      if ((row[d]?.totalMs ?? 0) >= PRESENT_MIN_MS) here += 1;
    }
    presentSlots += here;
    if (dayCount > 0 && here === dayCount) perfect += 1;
  }
  const rate = slots > 0 ? Math.round((presentSlots / slots) * 100) : 0;

  return (
    <Card variant="flush">
      <StatRow>
        <Stat label="Present rate" value={rate} unit="%" hint={`${fmtDayLabel(data.from, timeZone)} – ${fmtDayLabel(data.to, timeZone)}`} />
        <Stat label="People" value={total} hint="in scope" />
        <Stat label="Full house" value={perfect} unit={`/ ${total}`} hint="present every day" />
        <Stat label="Days" value={dayCount} hint="in this range" />
      </StatRow>
    </Card>
  );
}

/**
 * The month on one screen: a row per person with the same numbers as the
 * Excel — present, half day, leave, leave without approval, late — plus the
 * salary cut and the leave left. Details opens everything behind the row.
 *
 * Hidden when the viewer may not read the team.
 */
function MonthSummary({ month, isAdmin }: { month: string; isAdmin: boolean }) {
  const [open, setOpen] = useState<MonthSummaryRow | null>(null);
  const q = useQuery({
    queryKey: ['admin', 'month-summary', month],
    queryFn: () => api<MonthSummaryResponse>(`/v1/reports/month-summary?month=${month}`),
    retry: false,
  });
  const data = q.data;
  // Hidden only when the viewer may not read the team (403). Loading and
  // other failures used to return null too, leaving this — the default
  // view — as a blank page with no spinner, error or retry.
  if (!data) {
    if (q.error instanceof ApiError && q.error.status === 403) return null;
    return (
      <Card variant="flush" className="atd-card">
        {q.isError ? (
          <EmptyState
            tone="danger"
            title="Couldn’t load the month summary"
            description={(q.error as Error).message}
            action={<Button variant="secondary" onClick={() => void q.refetch()}>Retry</Button>}
          />
        ) : (
          <SkeletonTable rows={6} />
        )}
      </Card>
    );
  }

  return (
    <Card variant="flush" className="atd-card">
      <div className="atd-card-head">
        <div>
          <h2 className="ui-t-title">Month summary · {fmtMonthLong(month)}</h2>
          <p className="ui-t-small">
            {data.rulesFrom
              ? 'Same numbers as the Excel. Salary cut is leave the balance could not pay for.'
              : 'Attendance rules are off — set them in Policy.'}
          </p>
        </div>
      </div>
      <div className="atd-scroll">
        <Table density="compact" stickyHead>
          <THead>
            <Tr>
              <Th>Person</Th>
              <Th align="right">Present</Th>
              <Th align="right">Half day</Th>
              <Th align="right">Leave</Th>
              <Th align="right">LWA</Th>
              <Th align="right">Late</Th>
              <Th align="right">Salary cut</Th>
              <Th align="right">Leave left</Th>
              <Th align="right" />
            </Tr>
          </THead>
          <Tbody>
            {data.rows.map((r) => (
              <Tr key={r.userId}>
                <Td>
                  <Identity
                    name={
                      r.mode === 'STANDARD' ? r.name : (
                        <>
                          {r.name}{' '}
                          <Tag status={r.mode === 'EXEMPT' ? 'neutral' : 'info'} mono>
                            {r.mode === 'EXEMPT' ? 'No rules' : 'Remote'}
                          </Tag>
                        </>
                      )
                    }
                    subtitle={r.teamName ?? r.email}
                    avatar={<Avatar name={r.name} size={32} />}
                  />
                </Td>
                <Td align="right"><span className="ui-mono">{r.present}</span></Td>
                <Td align="right"><span className="ui-mono">{r.halfDay}</span></Td>
                <Td align="right"><span className="ui-mono">{r.leave}</span></Td>
                <Td align="right"><span className="ui-mono">{r.lwa}</span></Td>
                <Td align="right"><span className="ui-mono">{r.late}</span></Td>
                <Td align="right">
                  <span className="ui-mono">{r.salaryCut > 0 ? <strong>{fmtDays(r.salaryCut)}</strong> : '0'}</span>
                </Td>
                <Td align="right"><span className="ui-mono">{fmtDays(r.account.closing)}</span></Td>
                <Td align="right">
                  <Button size="sm" variant="secondary" onClick={() => setOpen(r)}>
                    Details
                  </Button>
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </div>
      <MonthDetails row={open} month={month} isAdmin={isAdmin} onClose={() => setOpen(null)} />
    </Card>
  );
}

/** "2", "1.5" — halves kept, whole numbers whole. */
function fmtDays(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/**
 * Everything behind one row: the leave account, then every change this month —
 * what came in, and each day that became leave with why, what the balance paid
 * and what was cut from salary. An admin can change the person's leave
 * settings from here.
 */
function MonthDetails({
  row, month, isAdmin, onClose,
}: { row: MonthSummaryRow | null; month: string; isAdmin: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<LeaveBalanceRow | null>(null);
  const monthEnd = lastDayOf(month);
  // The settings behind the balance, fetched only when an admin asks to edit.
  const [settingsError, setSettingsError] = useState<string | null>(null);
  useEffect(() => setSettingsError(null), [row?.userId]);
  const loadSettings = async () => {
    // Used to be fire-and-forget: a failed fetch was an unhandled rejection
    // and a missing row left editing null, so the button did nothing.
    setSettingsError(null);
    try {
      const res = await api<LeaveBalancesResponse>(`/v1/admin/leave/balances?asOf=${monthEnd}`);
      const found = res.rows.find((x) => x.userId === row?.userId) ?? null;
      if (!found) setSettingsError('No leave settings found for this person.');
      setEditing(found);
    } catch (e) {
      setSettingsError(e instanceof Error ? e.message : 'Could not load leave settings.');
    }
  };
  const a = row?.account;
  const signed = (n: number) => (n > 0 ? `+${fmtDays(n)}` : n < 0 ? `−${fmtDays(-n)}` : '0');

  return (
    <>
      <Modal
        open={row !== null && editing === null}
        onClose={onClose}
        title={row ? `${row.name} — ${fmtMonthLong(month)}` : ''}
        description={
          a
            ? `Leave: at start ${fmtDays(a.opening)} · got ${signed(a.earned)} · used ${signed(-a.paid)} · left ${fmtDays(a.closing)}` +
              (row && row.salaryCut > 0 ? ` · salary cut ${fmtDays(row.salaryCut)} days` : '')
            : undefined
        }
        actions={
          <>
            {isAdmin && (
              <Button variant="ghost" onClick={() => void loadSettings()}>
                Edit leave settings
              </Button>
            )}
            <Button variant="secondary" onClick={onClose}>Close</Button>
          </>
        }
      >
        {settingsError && <Banner status="danger">{settingsError}</Banner>}
        {a && a.lines.length === 0 ? (
          <p className="ui-t-small">Nothing changed this month.</p>
        ) : (
          <Table density="compact">
            <THead>
              <Tr>
                <Th>Date</Th>
                <Th>Day</Th>
                <Th>What</Th>
                <Th align="right">Paid</Th>
                <Th align="right">Salary cut</Th>
              </Tr>
            </THead>
            <Tbody>
              {a?.lines.map((l, i) => (
                <Tr key={`${l.date}-${i}`}>
                  <Td><span className="ui-mono atd-nowrap">{l.date.slice(8, 10)}/{l.date.slice(5, 7)}</span></Td>
                  <Td>{l.kind === 'leave' && l.code ? <Tag mono>{l.code}</Tag> : <Tag status="success" mono>{signed(l.days)}</Tag>}</Td>
                  <Td>{l.label}</Td>
                  <Td align="right"><span className="ui-mono">{l.kind === 'leave' ? fmtDays(l.paid ?? 0) : '—'}</span></Td>
                  <Td align="right">
                    <span className="ui-mono">
                      {l.kind === 'leave' && (l.salaryCut ?? 0) > 0 ? <strong>{fmtDays(l.salaryCut ?? 0)}</strong> : '—'}
                    </span>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Modal>
      <EditMemberModal
        row={editing}
        month={month}
        onClose={() => setEditing(null)}
        onSaved={() => {
          void qc.invalidateQueries({ queryKey: ['admin', 'month-summary'] });
          void qc.invalidateQueries({ queryKey: ['leave'] });
        }}
      />
    </>
  );
}

function lastDayOf(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(y!, m!, 0)).getUTCDate()).padStart(2, '0')}`;
}

/** "2026-09" moved by n months. */
function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
