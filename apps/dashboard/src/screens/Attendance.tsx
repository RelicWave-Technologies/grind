import './attendance.css';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouteContext } from '@tanstack/react-router';
import { CalendarRange, FileSpreadsheet, Sheet } from 'lucide-react';
import { api, ApiError, API_BASE } from '../lib/api';
import { attendanceQuery, monthSummaryQuery } from '../lib/queries';
import { useMonthReportDownload, fmtMonthLong } from '../lib/useMonthReportDownload';
import type { TimesheetMatrix } from '../lib/types';
import type { MonthSummaryResponse, MonthSummaryRow } from '@grind/types';
import type { LeaveBalanceRow, LeaveBalancesResponse } from '../lib/types';
import { EditMemberModal } from './Calendar';
import { UnitPicker } from '../components/UnitPicker';
import { roleLabel } from '../lib/auth';
import { fmtTime, fmtDurationMs, fmtDayLabel, monthBounds, todayKey } from '../lib/format';
import { personFacets, personSearchFields, useTableFilter } from '../lib/tableFilter';
import { useTableSort } from '../lib/tableSort';
import {
  addMonths,
  defaultReportMonth,
  defaultReportRange,
  monthRange,
  stepRange,
  trailingRange,
  type DateRange,
} from '../lib/reportRange';
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
  FilterBar,
  NoMatches,
  SkeletonTable,
  Modal,
} from '../ui';

const SCOPE_LABEL: Record<TimesheetMatrix['scope'], string> = {
  self: 'Just you',
  team: 'Your team',
  workspace: 'Entire workspace',
};

const MODE_LABEL: Record<string, string> = { STANDARD: 'Standard', EXEMPT: 'No rules', REMOTE: 'Remote' };

/** The daily grid's spans: the month (opens on the month rule) or the last N days. */
type DailySpan = 'month' | '7' | '14' | '30';
const SPANS: ReadonlyArray<{ value: DailySpan; label: string }> = [
  { value: 'month', label: 'Month' },
  { value: '7', label: '7d' },
  { value: '14', label: '14d' },
  { value: '30', label: '30d' },
];
const spanDays = (span: DailySpan): 'month' | number => (span === 'month' ? 'month' : Number(span));

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

  const today = todayKey(tz);

  // Both views open on the month rule (lib/reportRange): up to the 10th the
  // month just closed, from the 11th this month so far.
  const [span, setSpan] = useState<DailySpan>('month');
  const [range, setRange] = useState<DateRange>(() => defaultReportRange(today));
  const { from, to } = range;

  function changeSpan(next: DailySpan) {
    setSpan(next);
    setRange(next === 'month' ? monthRange(to.slice(0, 7), today) : trailingRange(to, Number(next)));
  }

  const q = useQuery(attendanceQuery<TimesheetMatrix>({ from, to, tz }));

  function csvUrl(): string {
    const params = new URLSearchParams({ from, to, tz });
    return `${API_BASE}/v1/admin/timesheets.csv?${params.toString()}`;
  }

  // Two views, one at a time: the month as HR closes it (default), and the
  // day-by-day activity grid. The month report (Excel/CSV) is always a WHOLE
  // month — its header says "Report Month" — so it follows the month view.
  const [view, setView] = useState<'month' | 'daily'>('month');
  const [reportMonth, setReportMonth] = useState<string>(() => defaultReportMonth(today));
  const thisMonth = today.slice(0, 7);
  const monthReport = useMonthReportDownload();
  const [downloadUnit, setDownloadUnit] = useState('');

  const tzLabel = tz.replace(/_/g, ' ');
  const days = spanDays(span);
  const data = q.data;
  const hasPeople = !!data && data.users.length > 0;
  const people = useTableFilter(
    data?.users ?? [],
    {
      text: (u) => [...personSearchFields(u), roleLabel(u.role)],
      facets: personFacets((u: TimesheetMatrix['users'][number]) => u),
    },
    { urlPrefix: 'daily.' },
  );
  const peopleSort = useTableSort(people.rows, {
    person: (u) => u.name,
    present: (u) => {
      const row = data?.cells[u.id] ?? {};
      return (data?.days ?? []).filter((d) => (row[d]?.totalMs ?? 0) >= PRESENT_MIN_MS).length;
    },
  });

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
              onPrev={() => setReportMonth((m) => addMonths(m, -1))}
              onNext={() => setReportMonth((m) => addMonths(m, 1))}
              nextDisabled={reportMonth >= thisMonth}
              prevLabel="Previous month"
              nextLabel="Next month"
            />
            <UnitPicker value={downloadUnit} onChange={setDownloadUnit} />
            <Button
              variant="secondary"
              icon={<FileSpreadsheet size={14} strokeWidth={2} />}
              loading={monthReport.downloading === 'xlsx'}
              disabled={monthReport.downloading !== null}
              onClick={() => void monthReport.download(reportMonth, 'xlsx', downloadUnit || undefined)}
            >
              Excel
            </Button>
            <Button
              variant="secondary"
              icon={<Sheet size={14} strokeWidth={2} />}
              loading={monthReport.downloading === 'csv'}
              disabled={monthReport.downloading !== null}
              onClick={() => void monthReport.download(reportMonth, 'csv', downloadUnit || undefined)}
            >
              CSV
            </Button>
          </Toolbar>
          ) : (
          <Toolbar>
            <Segmented aria-label="Days shown" value={span} onChange={changeSpan} items={SPANS} />
            <DateStepper
              value={
                days === 'month'
                  ? fmtMonthLong(to.slice(0, 7))
                  : to === today
                    ? 'Today'
                    : fmtDayLabel(to, tz)
              }
              onPrev={() => setRange((r) => stepRange(r, days, -1, today))}
              onNext={() => setRange((r) => stepRange(r, days, 1, today))}
              nextDisabled={to >= today}
              prevLabel={days === 'month' ? 'Previous month' : 'Previous range'}
              nextLabel={days === 'month' ? 'Next month' : 'Next range'}
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
            <FilterBar
              filter={people}
              placeholder="Search name, email, team, role…"
              noun={{ one: 'person', other: 'people' }}
            />
            {people.rows.length === 0 ? (
              <NoMatches onClear={people.clear} />
            ) : (
              <Table density="compact" stickyCol className="atd-table">
                <colgroup>
                  <col className="atd-col-person" />
                  {data!.days.map((d) => (
                    <col key={d} className="atd-col-day" />
                  ))}
                  <col className="atd-col-present" />
                </colgroup>
                <THead>
                  <Tr>
                    <Th className="atd-col-person" {...peopleSort.th('person')}>Person</Th>
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
                    <Th className="atd-col-present" align="center" {...peopleSort.th('present')}>Present</Th>
                  </Tr>
                </THead>
                <Tbody>
                  {peopleSort.rows.map((u) => {
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
                            subtitle={u.teamName ?? roleLabel(u.role)}
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
            )}
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
 * Excel — present, half day, paid leave, leave, leave without approval, late —
 * plus the days salary is paid for and the leave left. Details opens everything
 * behind the row.
 *
 * Hidden when the viewer may not read the team.
 */
function MonthSummary({ month, isAdmin }: { month: string; isAdmin: boolean }) {
  const [open, setOpen] = useState<MonthSummaryRow | null>(null);
  const q = useQuery(monthSummaryQuery<MonthSummaryResponse>(month));
  const data = q.data;
  const filter = useTableFilter(
    data?.rows ?? [],
    {
      text: (r) => personSearchFields(r),
      facets: {
        ...personFacets((r: MonthSummaryRow) => r),
        mode: { label: 'Modes', value: (r) => r.mode, optionLabel: (m) => MODE_LABEL[m] ?? m },
      },
    },
    { urlPrefix: 'month.' },
  );
  const sort = useTableSort(filter.rows, {
    person: (r) => r.name,
    present: (r) => r.present,
    halfDay: (r) => r.halfDay,
    pl: (r) => r.pl,
    leave: (r) => r.leave,
    lwa: (r) => r.lwa,
    late: (r) => r.late,
    payable: (r) => r.payableDays,
    left: (r) => r.account.closing,
  });
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
              ? 'Same numbers as the Excel. Payable days = days in the month so far − leave the balance could not pay for.'
              : 'Attendance rules are off — set them in Policy.'}
          </p>
        </div>
      </div>
      {data.rows.length > 0 && (
        <FilterBar
          filter={filter}
          placeholder="Search name, email, team…"
          noun={{ one: 'person', other: 'people' }}
        />
      )}
      {data.rows.length === 0 ? (
        <EmptyState title="No people this month" description="There’s no one in scope for this month." />
      ) : filter.rows.length === 0 ? (
        <NoMatches onClear={filter.clear} />
      ) : (
        <Table density="compact">
          <THead>
            <Tr>
              <Th {...sort.th('person')}>Person</Th>
              <Th align="right" {...sort.th('present')}>Present</Th>
              <Th align="right" {...sort.th('halfDay')}>Half day</Th>
              <Th align="right" {...sort.th('pl')}>PL</Th>
              <Th align="right" {...sort.th('leave')}>Leave</Th>
              <Th align="right" {...sort.th('lwa')}>LWA</Th>
              <Th align="right" {...sort.th('late')}>Late</Th>
              <Th align="right" {...sort.th('payable')}>Payable days</Th>
              <Th align="right" {...sort.th('left')}>Leave left</Th>
              <Th align="right" />
            </Tr>
          </THead>
          <Tbody>
            {sort.rows.map((r) => (
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
                <Td align="right"><span className="ui-mono">{r.pl}</span></Td>
                <Td align="right"><span className="ui-mono">{r.leave}</span></Td>
                <Td align="right"><span className="ui-mono">{r.lwa}</span></Td>
                <Td align="right"><span className="ui-mono">{r.late}</span></Td>
                <Td align="right">
                  <span className="ui-mono" title={r.salaryCut > 0 ? `${fmtDays(r.salaryCut)} unpaid` : undefined}>
                    {r.salaryCut > 0 ? <strong>{fmtDays(r.payableDays)}</strong> : fmtDays(r.payableDays)}
                  </span>
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
      )}
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
  const monthEnd = monthBounds(month).to;
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
            ? `Leave: at start ${fmtDays(a.opening)} · monthly ${signed(a.earnedMonthly)} · birthday ${signed(a.earnedBirthday)}` +
              (a.earnedOther !== 0 ? ` · adjusted ${signed(a.earnedOther)}` : '') +
              ` · used ${signed(-a.paid)} · left ${fmtDays(a.closing)}` +
              (row ? ` · salary for ${fmtDays(row.payableDays)} days${row.salaryCut > 0 ? ` (${fmtDays(row.salaryCut)} unpaid)` : ''}` : '')
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
                <Th align="right">Unpaid</Th>
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
