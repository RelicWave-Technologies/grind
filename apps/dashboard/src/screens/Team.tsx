import './team.css';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Calendar, ArrowUpRight, Download, Users } from 'lucide-react';
import { api, API_BASE } from '../lib/api';
import type { TimesheetMatrix } from '../lib/types';
import { fmtDurationMs, fmtDayLabel, addDays, todayKey } from '../lib/format';
import {
  Page,
  PageHeader,
  Card,
  Stat,
  StatRow,
  Table,
  THead,
  Tbody,
  Th,
  Tr,
  Td,
  Avatar,
  Identity,
  Button,
  Segmented,
  Toolbar,
  DateStepper,
  Tag,
  Banner,
  EmptyState,
  SkeletonTable,
} from '../ui';

const SCOPE_LABEL: Record<TimesheetMatrix['scope'], string> = {
  self: 'Just you',
  team: 'Your team',
  workspace: 'Entire workspace',
};

const RANGES: Array<{ value: '7' | '14' | '30'; label: string; days: number }> = [
  { value: '7', label: '7d', days: 7 },
  { value: '14', label: '14d', days: 14 },
  { value: '30', label: '30d', days: 30 },
];

/* ── Heat ramp — the ONE sanctioned colour zone (SYSTEM.md §4 sequential
 * intensity): a single-hue ramp of the accent at fixed steps,
 *   --accent-tint → --accent-tint-2 → color-mix(accent 55% white) → accent.
 * A cell's intensity (total / maxTotal) samples this ramp so the matrix reads
 * as one calm violet field that deepens with hours. No multi-hue gradient, no
 * rainbow — the only place --accent fills an area (it counts toward the ≤3
 * budget). The RGB stops below are exactly those token values, used solely for
 * this data-viz ramp. Past STRONG_AT the ground is dark enough that the figure
 * flips to --on-accent. Empty cells stay a bare mono dash — the quiet baseline.
 * Presentation only: what a cell encodes (total tracked time) is unchanged. */
const RAMP: Array<[number, number, number]> = [
  [0xee, 0xee, 0xfb], // 0.00  --accent-tint
  [0xe2, 0xe2, 0xf7], // 0.33  --accent-tint-2
  [0xa5, 0xa5, 0xe8], // 0.66  color-mix(accent 55%, white)
  [0x5b, 0x5b, 0xd6], // 1.00  --accent
];
const HEAT_FLOOR = 0.1; // faintest non-empty step so 1-minute days still register
const STRONG_AT = 0.62; // intensity past which the accent ground needs --on-accent text

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

/** Sample the accent ramp at t∈[0,1] → an `rgb()` string. */
function rampColor(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  const span = clamped * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(span));
  const f = span - i;
  const [r1, g1, b1] = RAMP[i]!;
  const [r2, g2, b2] = RAMP[i + 1]!;
  return `rgb(${lerp(r1, r2, f)}, ${lerp(g1, g2, f)}, ${lerp(b1, b2, f)})`;
}

/** Map a cell's raw intensity onto the visible ramp (floored so faint days show). */
function heatStop(intensity: number): number {
  return HEAT_FLOOR + intensity * (1 - HEAT_FLOOR);
}

/**
 * Team timesheets — a manager's heat-mapped users × days matrix, composed
 * entirely from the shared "Quiet Datasheet" kit (Page / PageHeader / Toolbar /
 * Segmented / DateStepper / Card / StatRow / Table / Identity / Avatar / Tag /
 * Banner / EmptyState). The matrix is the one colour zone — every cell is a step
 * on the single accent intensity ramp (SYSTEM.md §4), so tracked intensity reads
 * instantly off the legend (not a rainbow). Hover surfaces the worked / meeting /
 * manual breakdown; click a cell to drill into that day for that person (via
 * /me-today with ?userId= ?date=).
 *
 * Presentation only — the data shape, the cell encoding (total tracked time),
 * the range / anchor controls, the CSV export and the click-through contract are
 * all unchanged. Route stays MANAGER+ only (MEMBERs hitting this URL get 403'd).
 */
export function TeamScreen() {
  const navigate = useNavigate();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  // Anchor = the right-most ("to") day in the window. Defaults to today.
  // Range size + anchor make navigation predictable; full date picker
  // lives behind the "Custom…" affordance (future).
  const [anchor, setAnchor] = useState<string>(todayKey());
  const [rangeKey, setRangeKey] = useState<'7' | '14' | '30'>('7');
  const days = RANGES.find((r) => r.value === rangeKey)!.days;
  const from = addDays(anchor, -(days - 1));

  const q = useQuery({
    queryKey: ['admin', 'timesheets', from, anchor, tz],
    queryFn: () => {
      const params = new URLSearchParams({ from, to: anchor, tz });
      return api<TimesheetMatrix>(`/v1/admin/timesheets?${params.toString()}`);
    },
  });

  const maxTotal = useMemo(() => {
    if (!q.data) return 0;
    let m = 0;
    for (const u of q.data.users) {
      const row = q.data.cells[u.id];
      if (!row) continue;
      for (const day of q.data.days) {
        const c = row[day];
        if (c && c.totalMs > m) m = c.totalMs;
      }
    }
    return m;
  }, [q.data]);

  const csvHref = `${API_BASE}/v1/admin/timesheets.csv?${new URLSearchParams({ from, to: anchor, tz }).toString()}`;
  const eyebrow = `${tz.replace(/_/g, ' ')} · Timesheets`;
  const isNow = anchor === todayKey();

  const subtitle = q.data
    ? `${SCOPE_LABEL[q.data.scope]} · ${fmtDayLabel(q.data.from)} → ${fmtDayLabel(q.data.to)}`
    : 'Loading the matrix…';

  return (
    <Page>
      <PageHeader
        eyebrow={eyebrow}
        title="Team"
        subtitle={subtitle}
        actions={
          <Toolbar>
            <Segmented
              value={rangeKey}
              onChange={(v) => setRangeKey(v as '7' | '14' | '30')}
              items={RANGES.map((r) => ({ value: r.value, label: r.label }))}
            />
            <DateStepper
              value={
                <span className="tm-anchor-val">
                  <Calendar size={12} strokeWidth={2} aria-hidden />
                  {isNow ? 'Now' : fmtDayLabel(anchor)}
                </span>
              }
              onPrev={() => setAnchor((d) => addDays(d, -days))}
              onNext={() => setAnchor((d) => addDays(d, days))}
              nextDisabled={isNow}
              prevLabel="Previous range"
              nextLabel="Next range"
            />
            <a className="ui-btn ui-btn--primary ui-btn--md" href={csvHref} download>
              <span className="ui-btn__icon">
                <Download size={14} strokeWidth={2} />
              </span>
              <span className="ui-btn__label">Export CSV</span>
            </a>
          </Toolbar>
        }
      />

      {q.isLoading && (
        <Card variant="flush">
          <SkeletonTable rows={6} />
        </Card>
      )}

      {q.isError && (
        <Banner
          status="danger"
          action={
            <Button variant="ghost" size="sm" onClick={() => q.refetch()}>
              Retry
            </Button>
          }
        >
          Couldn&apos;t load the timesheets: {(q.error as Error).message}
        </Banner>
      )}

      {q.data && q.data.users.length === 0 && (
        <Card variant="flush">
          <EmptyState
            icon={<Users size={22} strokeWidth={1.8} />}
            title="No users in scope"
            description="No one falls under your timesheet view for this range."
          />
        </Card>
      )}

      {q.data && q.data.users.length > 0 && (
        <>
          <Card variant="flush">
            <StatRow>
              <Stat
                label="People"
                value={q.data.users.length}
                unit={q.data.users.length === 1 ? 'person' : 'people'}
              />
              <Stat label="Days" value={q.data.days.length} />
              <Stat label="Peak day" value={maxTotal > 0 ? fmtDurationMs(maxTotal) : '—'} />
            </StatRow>
          </Card>

          <Card variant="flush">
            <div className="tm-scroll">
              <Table stickyHead stickyCol>
                <THead>
                  <Tr>
                    <Th>Person</Th>
                    {q.data.days.map((d) => {
                      const date = new Date(`${d}T00:00:00`);
                      return (
                        <Th key={d} align="center">
                          <span className="tm-day-head">
                            <span>
                              {new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(date)}
                            </span>
                            <span className="tm-day-num mono">
                              {new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)}
                            </span>
                          </span>
                        </Th>
                      );
                    })}
                    <Th align="right">Total</Th>
                  </Tr>
                </THead>
                <Tbody>
                  {q.data.users.map((u) => {
                    const row = q.data!.cells[u.id] ?? {};
                    const rowTotal = q.data!.days.reduce((sum, d) => sum + (row[d]?.totalMs ?? 0), 0);
                    return (
                      <Tr key={u.id}>
                        <Td>
                          <Identity
                            name={u.name}
                            subtitle={u.role.toLowerCase()}
                            avatar={<Avatar name={u.name} />}
                          />
                        </Td>
                        {q.data!.days.map((d) => {
                          const cell = row[d];
                          const total = cell?.totalMs ?? 0;
                          const intensity = maxTotal > 0 ? Math.min(1, total / maxTotal) : 0;
                          const stop = total > 0 ? heatStop(intensity) : 0;
                          const strong = total > 0 && intensity >= STRONG_AT;
                          const isPeak = total > 0 && total === maxTotal;
                          return (
                            <Td key={d} align="center" className="tm-day-cell">
                              <button
                                type="button"
                                className={
                                  `tm-cell mono${total === 0 ? ' is-empty' : ''}` +
                                  `${strong ? ' is-strong' : ''}${isPeak ? ' is-peak' : ''}`
                                }
                                onClick={() => navigate({ to: '/me-today', search: { date: d, userId: u.id } })}
                                title={
                                  cell
                                    ? `${fmtDurationMs(cell.totalMs)} total · ${fmtDurationMs(cell.workedMs)} work · ${fmtDurationMs(cell.meetingMs)} mtg · ${fmtDurationMs(cell.manualMs)} manual`
                                    : 'No tracked time'
                                }
                                style={total > 0 ? { ['--tm-heat' as string]: rampColor(stop) } : undefined}
                              >
                                <span>{total > 0 ? fmtDurationMs(total) : '—'}</span>
                                {cell && cell.manualMs > 0 && (
                                  <span className="tm-cell-manual" title="includes manual time" />
                                )}
                              </button>
                            </Td>
                          );
                        })}
                        <Td mono>{fmtDurationMs(rowTotal)}</Td>
                      </Tr>
                    );
                  })}
                </Tbody>
              </Table>
            </div>

            <div className="tm-legend">
              <div className="tm-legend-scale">
                <span className="ui-t-eyebrow">Less</span>
                <span className="tm-legend-ramp" aria-hidden>
                  {[0, 0.25, 0.5, 0.75, 1].map((step) => (
                    <span key={step} className="tm-legend-swatch" style={{ background: rampColor(step) }} />
                  ))}
                </span>
                <span className="ui-t-eyebrow">More tracked</span>
              </div>
              <span className="tm-legend-keys">
                <Tag status="neutral" dot>
                  No time
                </Tag>
                <Tag status="info" dot>
                  Includes manual
                </Tag>
                <span className="tm-legend-hint ui-t-small">
                  <ArrowUpRight size={12} strokeWidth={2} aria-hidden /> Click a cell to open the day
                </span>
              </span>
            </div>
          </Card>
        </>
      )}
    </Page>
  );
}
