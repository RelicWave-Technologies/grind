import './attendance.css';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRouteContext } from '@tanstack/react-router';
import { CalendarRange } from 'lucide-react';
import { api, API_BASE } from '../lib/api';
import type { TimesheetMatrix } from '../lib/types';
import { fmtTime, fmtDurationMs, fmtDayLabel, addDays, todayKey } from '../lib/format';
import {
  Page,
  PageHeader,
  Toolbar,
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

  const isToday = anchor === todayKey(tz);
  const today = todayKey(tz);
  const tzLabel = tz.replace(/_/g, ' ');
  const data = q.data;
  const hasPeople = !!data && data.users.length > 0;

  const subtitle = data
    ? `${SCOPE_LABEL[data.scope]} — first and last activity across ${data.days.length} days.`
    : 'Assembling the attendance matrix…';

  return (
    <Page>
      <PageHeader
        eyebrow={`Attendance · ${tzLabel}`}
        title="Who showed up"
        subtitle={subtitle}
        actions={
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
        }
      />

      {hasPeople && <AttendanceSummary data={data!} timeZone={tz} />}

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
