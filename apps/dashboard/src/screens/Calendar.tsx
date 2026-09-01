import './calendar.css';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouteContext } from '@tanstack/react-router';
import { CalendarDays, ChevronLeft, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { hasCapability } from '../lib/auth';
import { todayKey, fmtDayLabel } from '../lib/format';
import type {
  HolidayDto,
  LeaveAwayDay,
  LeaveBalanceResponse,
  LeaveCalendarResponse,
  LeavePolicyResponse,
  LeaveRequestDto,
  LeaveBalanceRow,
  LeaveBalancesResponse,
} from '../lib/types';
import {
  Page,
  PageHeader,
  Toolbar,
  Button,
  IconButton,
  Card,
  StatRow,
  Stat,
  Table,
  THead,
  Tbody,
  Tr,
  Th,
  Td,
  Tag,
  Avatar,
  AvatarGroup,
  Identity,
  Field,
  Input,
  Select,
  Banner,
  Modal,
  EmptyState,
  Skeleton,
  SkeletonTable,
  Tabs,
} from '../ui';

/**
 * Calendar — company holidays, who is away, and a person's paid-leave balance.
 *
 * Composed from the shared "Quiet Datasheet" kit, like the other pages: the KPI
 * strip is the kit's StatRow (which cycles the Figma block pastels across its
 * tiles), the tables and tags are kit primitives, and this file contributes
 * layout only.
 *
 * The month grid is the one pattern the kit has no primitive for, so it lives
 * in calendar.css — built entirely from --ui-* tokens, no bespoke colour, type,
 * radius or shadow. Its own palette is borrowed from the same block pastels the
 * StatRow uses, so a lime holiday on the grid and a lime tile above it are the
 * same lime.
 *
 * Every amount is a day on the 0.5 grid, the same unit the API, the ledger and
 * the month-end report use, so nothing converts on the way to the eye.
 */

/** Render a day amount the way the rest of the product does: "1", "0.5", "2.5". */
function days(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

const PORTION_LABEL: Record<string, string> = {
  FULL: 'Full day',
  FIRST_HALF: 'First half',
  SECOND_HALF: 'Second half',
};

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Turn an API error code into something a person can act on.
 *
 * `no_working_days` and `no_shift_assigned` are the pair worth separating:
 * the first is "you picked a weekend", the second is "nobody has told Timo
 * when you work", which is an admin problem the requester cannot fix and must
 * not be told to try.
 */
const ERROR_TEXT: Record<string, string> = {
  no_shift_assigned:
    'Timo does not know your working days yet — you have no shift assigned. Ask an admin to set one in Shifts; leave cannot be priced until then.',
  no_working_days:
    'Those dates are all non-working days for you — weekends, or a company holiday. Pick a day you would normally work.',
  overlapping_request:
    'You already have a leave request covering one of those dates.',
  insufficient_balance:
    'That is more paid leave than your balance covers.',
  invalid_range: 'Check the dates — the end cannot be before the start.',
  approval_dispatch_failed:
    'Timo could not reach the approver. Nothing was saved; try again shortly.',
  external_approval: 'This request is decided in Lark, not here.',
  holiday_exists: 'There is already a holiday on that date.',
  forbidden: 'You do not have permission to do that.',
};

function humanError(message: string): string {
  return ERROR_TEXT[message] ?? message;
}

/**
 * Where a request stands, in the words a person would use.
 *
 * A pending request that Lark owns is NOT "waiting for Timo" — nothing here
 * will ever decide it, and showing a bare PENDING chip invites people to wait
 * on a screen that is never going to change. Say where it actually is.
 */
function requestStanding(r: LeaveRequestDto): { label: string; status: 'success' | 'danger' | 'warn' | 'neutral' } {
  if (r.status === 'APPROVED') {
    return { label: r.decisionSource === 'LARK_APPROVAL' ? 'Approved in Lark' : 'Approved', status: 'success' };
  }
  if (r.status === 'REJECTED') {
    return { label: r.decisionSource === 'LARK_APPROVAL' ? 'Declined in Lark' : 'Declined', status: 'danger' };
  }
  if (r.status === 'CANCELLED') return { label: 'Cancelled', status: 'neutral' };
  return r.larkInstanceCode
    ? { label: 'Waiting in Lark', status: 'warn' }
    : { label: 'Waiting for approval', status: 'warn' };
}

/** Somebody away on a given day, ready to render. */
export interface AwayPerson extends LeaveAwayDay {
  userId: string;
  name: string;
  avatarUrl: string | null;
}

interface MonthCell {
  date: string;
  day: number;
  inMonth: boolean;
  weekend: boolean;
}

/** Six weeks of Monday-first cells covering `YYYY-MM`, with the spill days. */
function monthCells(month: string): MonthCell[] {
  const [y, m] = month.split('-').map((n) => Number.parseInt(n, 10));
  const first = new Date(Date.UTC(y!, m! - 1, 1));
  // getUTCDay is Sunday-0; shift so Monday starts the week.
  const lead = (first.getUTCDay() + 6) % 7;
  const start = new Date(first);
  start.setUTCDate(start.getUTCDate() - lead);

  const cells: MonthCell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    cells.push({
      date: iso,
      day: d.getUTCDate(),
      inMonth: d.getUTCMonth() === m! - 1,
      weekend: dow === 0 || dow === 6,
    });
  }
  // Drop a trailing all-spill week so a short month does not render an empty row.
  return cells.slice(-7).every((c) => !c.inMonth) ? cells.slice(0, 35) : cells;
}

function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map((n) => Number.parseInt(n, 10));
  const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map((n) => Number.parseInt(n, 10));
  const d = new Date(Date.UTC(y!, m! - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthName(month: string): string {
  const [y, m] = month.split('-').map((n) => Number.parseInt(n, 10));
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleDateString('en-GB', {
    month: 'long',
    timeZone: 'UTC',
  });
}

export function CalendarScreen() {
  const { me } = useRouteContext({ from: '/authed' });
  const tz = me.workspaceTimezone;
  const qc = useQueryClient();
  const isAdmin = hasCapability(me, 'policy.manage');

  const today = todayKey(tz);
  const [month, setMonth] = useState<string>(() => today.slice(0, 7));
  const { from, to } = useMemo(() => monthBounds(month), [month]);
  const cells = useMemo(() => monthCells(month), [month]);
  const [tab, setTab] = useState<'month' | 'holidays' | 'mine' | 'balances'>('month');

  const calendarQ = useQuery({
    queryKey: ['leave', 'calendar', from, to],
    queryFn: () => api<LeaveCalendarResponse>(`/v1/leave/calendar?from=${from}&to=${to}`),
  });
  const balanceQ = useQuery({
    queryKey: ['leave', 'balance'],
    queryFn: () => api<LeaveBalanceResponse>('/v1/leave/me/balance'),
  });
  const policyQ = useQuery({
    queryKey: ['leave', 'policy'],
    queryFn: () => api<LeavePolicyResponse>('/v1/leave/policy'),
  });
  const mineQ = useQuery({
    queryKey: ['leave', 'me', 'requests'],
    queryFn: () => api<{ requests: LeaveRequestDto[] }>('/v1/leave/me/requests'),
  });

  const balance = balanceQ.data?.balance;
  const policy = policyQ.data;
  const data = calendarQ.data;

  /** date -> the holiday that lands on it. */
  const holidayByDate = useMemo(() => {
    const map = new Map<string, HolidayDto>();
    for (const h of data?.holidays ?? []) map.set(h.date, h);
    return map;
  }, [data]);

  /** date -> everyone away that day, with enough to draw a face. */
  const awayByDate = useMemo(() => {
    const map = new Map<string, AwayPerson[]>();
    if (!data) return map;
    const person = new Map(data.users.map((u) => [u.id, u] as const));
    for (const [userId, rows] of Object.entries(data.away)) {
      const u = person.get(userId);
      for (const row of rows) {
        const list = map.get(row.date) ?? [];
        list.push({
          ...row,
          userId,
          name: u?.name ?? 'Someone',
          avatarUrl: u?.avatarUrl ?? null,
        });
        map.set(row.date, list);
      }
    }
    // Stable order so the same faces sit in the same place every render.
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return map;
  }, [data]);

  const [dayOpen, setDayOpen] = useState<string | null>(null);

  /** 'September 2026' — every panel says which month it is showing. */
  const monthLabel = useMemo(() => {
    const [y, m] = month.split('-').map((n) => Number.parseInt(n, 10));
    return new Date(Date.UTC(y || 1970, (m || 1) - 1, 1))
      .toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }, [month]);

  /** Leave that touches the month on screen. A request spanning the month
   *  boundary belongs to both, so this is an overlap and not a start-date match. */
  const mineThisMonth = useMemo(
    () => (mineQ.data?.requests ?? []).filter((r) => r.startDate <= to && r.endDate >= from),
    [mineQ.data, from, to],
  );

  /** Balance charged for leave that touches the month on screen. A request
   *  straddling the boundary counts in both months, which is the honest answer
   *  when the tile is labelled with the month rather than pro-rated. */
  const takenThisMonth = useMemo(
    () => (mineQ.data?.requests ?? [])
      .filter((r) => r.status === 'APPROVED' && r.startDate <= to && r.endDate >= from)
      .reduce((sum, r) => sum + r.chargedDays, 0),
    [mineQ.data, from, to],
  );

  const awayCount = useMemo(
    () => Object.values(data?.away ?? {}).reduce((n, rows) => n + rows.length, 0),
    [data],
  );

  return (
    <Page className="cal-page">
      <PageHeader
        eyebrow="Time off"
        title="Calendar"
        subtitle={`Company holidays, approved leave and paid-leave balances — ${tz.replace(/_/g, ' ')}.`}
        actions={
          /* Every panel below follows this, so it belongs to the page and not
             to one tab's card — where it used to sit, leaving the other three
             tabs with no way to change the month they were showing. */
          <Toolbar>
            <IconButton
              aria-label="Previous month"
              icon={<ChevronLeft />}
              onClick={() => setMonth(shiftMonth(month, -1))}
            />
            <span className="cal-month-label">{monthLabel}</span>
            <IconButton
              aria-label="Next month"
              icon={<ChevronRight />}
              onClick={() => setMonth(shiftMonth(month, 1))}
            />
            <Button variant="secondary" onClick={() => setMonth(today.slice(0, 7))}>
              Today
            </Button>
          </Toolbar>
        }
      />

      {/* Two scopes sit in this row and used to look alike: the balance is a
          running total, the rest belong to the month on screen. Every hint now
          says which, because a number whose scope you have to guess is worse
          than no number. */}
      <StatRow>
        <Stat
          label="Your balance"
          value={balance ? days(balance.balanceDays) : '—'}
          unit="days"
          hint={
            policy
              ? `Running total · accrues ${days(policy.policy.monthlyAccrualDays)} a month`
              : 'Running total'
          }
        />
        <Stat
          label="You took"
          value={days(takenThisMonth)}
          unit="days"
          hint={monthLabel}
        />
        <Stat
          label="Holidays"
          value={data ? String(data.holidays.length) : '—'}
          hint={monthLabel}
        />
        <Stat
          label="Days away"
          value={data ? days(awayCount) : '—'}
          hint={`${monthLabel} · everyone`}
        />
      </StatRow>

      <Tabs
        items={[
          { value: 'month' as const, label: 'Month' },
          { value: 'holidays' as const, label: 'Company holidays' },
          { value: 'mine' as const, label: 'My leave' },
          ...(isAdmin ? [{ value: 'balances' as const, label: 'Balances' }] : []),
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'month' && (
        <Card>
          {calendarQ.isLoading ? (
            <Skeleton h={520} radius={10} />
          ) : (
            <div className="cal-scroll">
              <div className="cal-grid" role="grid" aria-label={`${monthName(month)} ${month.slice(0, 4)}`}>
                {DOW.map((d) => (
                  <div key={d} className="cal-dow" role="columnheader">
                    {d}
                  </div>
                ))}
                {cells.map((cell) => (
                  <DayCell
                    key={cell.date}
                    cell={cell}
                    isToday={cell.date === today}
                    holiday={holidayByDate.get(cell.date) ?? null}
                    away={awayByDate.get(cell.date) ?? []}
                    onOpen={() => setDayOpen(cell.date)}
                  />
                ))}
              </div>
            </div>
          )}

          <div className="cal-legend">
            <LegendItem kind="holiday" label="Company holiday" />
            <LegendItem kind="paid" label="Paid leave" />
            <LegendItem kind="unpaid" label="Unpaid leave" />
            <LegendItem kind="off" label="Weekend" />
          </div>
        </Card>
      )}

      <DayModal
        date={dayOpen}
        away={dayOpen ? (awayByDate.get(dayOpen) ?? []) : []}
        holiday={dayOpen ? (holidayByDate.get(dayOpen) ?? null) : null}
        tz={tz}
        onClose={() => setDayOpen(null)}
      />

      {tab === 'holidays' && (
        <HolidaysPanel
          holidays={data?.holidays ?? []}
          loading={calendarQ.isLoading}
          canEdit={isAdmin}
          onChanged={() => qc.invalidateQueries({ queryKey: ['leave'] })}
        />
      )}

      {tab === 'balances' && isAdmin && <BalancesPanel asOf={to} monthLabel={monthLabel} />}

      {tab === 'mine' && (
        <MyLeavePanel
          requests={mineThisMonth}
          monthLabel={monthLabel}
          loading={mineQ.isLoading}
          statement={balanceQ.data?.statement ?? []}
          decidedInLark={policy ? !policy.decidesInTimo : false}
        />
      )}
    </Page>
  );
}

// ---------------------------------------------------------------------------

function LegendItem({ kind, label }: { kind: string; label: string }) {
  return (
    <span className="cal-legend__item">
      <span className={`cal-legend__swatch cal-legend__swatch--${kind}`} />
      {label}
    </span>
  );
}

/** Faces shown on a cell before the rest collapse into +N. */
const MAX_FACES = 3;

function DayCell({
  cell,
  isToday,
  holiday,
  away,
  onOpen,
}: {
  cell: MonthCell;
  isToday: boolean;
  holiday: HolidayDto | null;
  away: AwayPerson[];
  onOpen: () => void;
}) {
  const classes = ['cal-day'];
  if (!cell.inMonth) classes.push('cal-day--outside');
  // A holiday paints its own cell, so it must not also read as quiet ground.
  if (cell.weekend && !holiday) classes.push('cal-day--off');

  const interactive = holiday !== null || away.length > 0;
  if (interactive) classes.push('cal-day--open');

  const label = `${cell.date}${holiday ? `, ${holiday.name}` : ''}${
    away.length ? `, ${away.length} away` : ''
  }`;

  return (
    <div
      className={classes.join(' ')}
      role="gridcell"
      // Only a day with something on it is clickable; an empty cell that
      // highlights and then opens an empty dialog is a small betrayal.
      {...(interactive
        ? {
            tabIndex: 0,
            'aria-label': label,
            onClick: onOpen,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpen();
              }
            },
          }
        : { 'aria-label': cell.date })}
    >
      <span className={`cal-daynum${isToday ? ' cal-daynum--today' : ''}`}>{cell.day}</span>

      {holiday && (
        <span className="cal-mark cal-mark--holiday" title={holiday.name}>
          {holiday.name}
        </span>
      )}

      {away.length > 0 && (
        <span className="cal-faces">
          <AvatarGroup max={MAX_FACES} size={24}>
            {away.map((a) => (
              <Avatar
                key={`${a.date}-${a.userId}`}
                name={a.name}
                src={a.avatarUrl ?? undefined}
                size={24}
                title={`${a.name} — ${PORTION_LABEL[a.portion ?? 'FULL']}`}
              />
            ))}
          </AvatarGroup>
        </span>
      )}
    </div>
  );
}

/** Everyone away on one day. */
function DayModal({
  date,
  away,
  holiday,
  tz,
  onClose,
}: {
  date: string | null;
  away: AwayPerson[];
  holiday: HolidayDto | null;
  tz: string;
  onClose: () => void;
}) {
  const total = away.reduce((n, a) => n + (a.portion === 'FULL' ? 1 : 0.5), 0);
  return (
    <Modal
      open={date !== null}
      onClose={onClose}
      title={date ? fmtDayLabel(date, tz) : ''}
      description={
        holiday
          ? `${holiday.name} — paid for everyone, and it costs nobody any balance.`
          : away.length === 0
            ? 'Nobody is away.'
            : `${away.length} ${away.length === 1 ? 'person' : 'people'} away · ${days(total)} ${
                total === 1 ? 'day' : 'days'
              } in total`
      }
      actions={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      {away.length > 0 && (
        <Table density="compact">
          <THead>
            <Tr>
              <Th>Person</Th>
              <Th>Portion</Th>
              <Th align="right">Days</Th>
            </Tr>
          </THead>
          <Tbody>
            {away.map((a) => (
              <Tr key={a.userId}>
                <Td>
                  <Identity
                    name={a.name}
                    avatar={<Avatar name={a.name} src={a.avatarUrl ?? undefined} size={24} />}
                    subtitle={a.kind === 'UNPAID_LEAVE' ? 'Unpaid' : undefined}
                  />
                </Td>
                <Td>{PORTION_LABEL[a.portion ?? 'FULL']}</Td>
                <Td align="right" mono>
                  {days(a.portion === 'FULL' ? 1 : 0.5)}
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      )}
    </Modal>
  );
}

function HolidaysPanel({
  holidays,
  loading,
  canEdit,
  onChanged,
}: {
  holidays: HolidayDto[];
  loading: boolean;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  /** Leaving the dialog must not leave a half-typed holiday behind it. */
  function closeModal() {
    setOpen(false);
    setDate('');
    setName('');
    setError(null);
  }

  const create = useMutation({
    mutationFn: () =>
      api<HolidayDto>('/v1/admin/leave/holidays', {
        method: 'POST',
        json: { date, name },
      }),
    onSuccess: () => {
      closeModal();
      onChanged();
    },
    onError: (e: Error) => setError(humanError(e.message)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/v1/admin/leave/holidays/${id}`, { method: 'DELETE' }),
    onSuccess: onChanged,
  });

  if (loading) return <SkeletonTable rows={4} />;

  const canSubmit = Boolean(date && name.trim()) && !create.isPending;

  return (
    <>
      {canEdit && (
        <Toolbar>
          <Button icon={<Plus />} onClick={() => setOpen(true)}>
            Add a holiday
          </Button>
        </Toolbar>
      )}

      <Modal
        open={open}
        onClose={closeModal}
        title="Add a company holiday"
        description="Paid for everyone, and it never draws down anybody's balance."
        actions={
          <>
            <Button variant="secondary" onClick={closeModal}>
              Cancel
            </Button>
            <Button disabled={!canSubmit} onClick={() => create.mutate()}>
              Add holiday
            </Button>
          </>
        }
      >
        {error && <Banner status="danger">{error}</Banner>}
        <Field label="Date">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Name">
          <Input
            value={name}
            placeholder="Diwali"
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSubmit) create.mutate();
            }}
          />
        </Field>
      </Modal>

      {holidays.length === 0 ? (
        <EmptyState
          icon={<CalendarDays />}
          title="No holidays this month"
          description={canEdit ? 'Add one above — it is paid for everyone and costs nobody any balance.' : 'An admin sets these up.'}
        />
      ) : (
        <Card>
          <Table>
            <THead>
              <Tr>
                <Th>Date</Th>
                <Th>Name</Th>
                <Th>Applies to</Th>
                {canEdit && <Th align="right">·</Th>}
              </Tr>
            </THead>
            <Tbody>
              {holidays.map((h) => (
                <Tr key={h.id}>
                  <Td mono align="left">{h.date}</Td>
                  <Td>{h.name}</Td>
                  <Td>{h.teamName ?? 'Everyone'}</Td>
                  {canEdit && (
                    <Td align="right">
                      <Button
                        variant="ghost"
                        icon={<Trash2 />}
                        onClick={() => remove.mutate(h.id)}
                        disabled={remove.isPending}
                      >
                        Remove
                      </Button>
                    </Td>
                  )}
                </Tr>
              ))}
            </Tbody>
          </Table>
        </Card>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function MyLeavePanel({
  requests,
  monthLabel,
  loading,
  statement,
  decidedInLark,
}: {
  requests: LeaveRequestDto[];
  monthLabel: string;
  loading: boolean;
  statement: LeaveBalanceResponse['statement'];
  decidedInLark: boolean;
}) {
  return (
    <>
      <p className="cal-scope-note">
        Showing leave that falls in <strong>{monthLabel}</strong>. Use the month arrows above to
        look at another one.
      </p>

      {decidedInLark && (
        <Banner status="info">
          Leave is applied for and approved in Lark, exactly as it always has been. Timo mirrors what
          Lark decided, usually within ten minutes, and keeps the balance — the one thing Lark does
          not track.
        </Banner>
      )}

      {loading ? (
        <SkeletonTable rows={4} />
      ) : requests.length === 0 ? (
        <EmptyState
          icon={<CalendarDays />}
          title="No leave yet"
          description={
            decidedInLark
              ? 'Anything you file in Lark shows up here once it is decided.'
              : 'No leave has been recorded for you.'
          }
        />
      ) : (
        <Card title="Your leave">
          <Table>
            <THead>
              <Tr>
                <Th>Dates</Th>
                <Th>Portion</Th>
                <Th align="right">Days</Th>
                <Th>Status</Th>
              </Tr>
            </THead>
            <Tbody>
              {requests.map((r) => (
                <Tr key={r.id}>
                  <Td mono align="left">
                    {r.startDate === r.endDate ? r.startDate : `${r.startDate} → ${r.endDate}`}
                  </Td>
                  <Td>{PORTION_LABEL[r.portion]}</Td>
                  <Td align="right" mono>
                    {days(r.chargedDays)}
                  </Td>
                  <Td>
                    <Tag status={requestStanding(r).status}>{requestStanding(r).label}</Tag>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </Card>
      )}

      {statement.length > 0 && (
        <Card title="Balance statement">
          <Table density="compact">
            <THead>
              <Tr>
                <Th>Date</Th>
                <Th>Entry</Th>
                <Th align="right">Change</Th>
              </Tr>
            </THead>
            <Tbody>
              {statement.map((e, i) => (
                <Tr key={`${e.effectiveOn}-${i}`}>
                  <Td mono align="left">{e.effectiveOn}</Td>
                  <Td>{e.reason ?? e.kind}</Td>
                  <Td align="right" mono>
                    {e.days > 0 ? `+${days(e.days)}` : days(e.days)}
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </Card>
      )}
    </>
  );
}


/**
 * Everybody's balance, and the settings behind it.
 *
 * The balance itself is deliberately not editable here. It is the sum of a
 * ledger, and a field that overwrites it would be exactly the counter this
 * design exists to avoid — so a correction is an adjustment entry, which
 * shows up in that person's statement.
 *
 * What IS editable is what produces the balance: the monthly rate, the accrual
 * start, and whether the last Saturday counts as a working day.
 */
function BalancesPanel({ asOf, monthLabel }: { asOf: string; monthLabel: string }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<LeaveBalanceRow | null>(null);
  const [adjusting, setAdjusting] = useState<LeaveBalanceRow | null>(null);

  // Balances as they stood at the end of the month on screen, not today's.
  // Scrolling back a month and seeing this month's numbers is the bug people
  // report as "the filter does nothing".
  const q = useQuery({
    queryKey: ['leave', 'balances', asOf],
    queryFn: () => api<LeaveBalancesResponse>(`/v1/admin/leave/balances?asOf=${asOf}`),
  });

  if (q.isLoading) return <SkeletonTable rows={8} />;
  const data = q.data;
  if (!data) return null;

  const refresh = () => qc.invalidateQueries({ queryKey: ['leave'] });

  return (
    <>
      <p className="cal-scope-note">
        Balances as they stood at the end of <strong>{monthLabel}</strong>.
      </p>

      <Card title={`Balances as of ${data.asOf}`}>
        <Table density="compact">
          <THead>
            <Tr>
              <Th>Person</Th>
              <Th align="right">Balance</Th>
              <Th align="right">Accrued</Th>
              <Th align="right">Used</Th>
              <Th align="right">Adjusted</Th>
              <Th>Rate</Th>
              <Th>Accrues from</Th>
              <Th align="right">·</Th>
            </Tr>
          </THead>
          <Tbody>
            {data.rows.map((r) => (
              <Tr key={r.userId}>
                <Td>
                  <Identity
                    name={r.name}
                    subtitle={r.teamName ?? r.email}
                    avatar={<Avatar name={r.name} src={r.avatarUrl ?? undefined} size={24} />}
                  />
                </Td>
                <Td align="right" mono>
                  {r.balanceDays < 0 ? (
                    <Tag status="danger">{days(r.balanceDays)}</Tag>
                  ) : (
                    days(r.balanceDays)
                  )}
                </Td>
                <Td align="right" mono>{days(r.accruedDays)}</Td>
                <Td align="right" mono>{days(r.consumedDays)}</Td>
                <Td align="right" mono>{r.adjustedDays === 0 ? '—' : days(r.adjustedDays)}</Td>
                <Td mono>
                  {days(r.effectiveAccrualDays)}/mo
                  {r.accrualDays === null && <span title="inherited from the workspace policy"> ·</span>}
                </Td>
                <Td mono align="left">
                  {r.joinedOnSet ? r.accrualStart : <Tag status="warn">{r.accrualStart}</Tag>}
                </Td>
                <Td align="right">
                  <Toolbar>
                    <Button size="sm" variant="ghost" onClick={() => setAdjusting(r)}>
                      Adjust
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setEditing(r)}>
                      Edit
                    </Button>
                  </Toolbar>
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </Card>

      <EditMemberModal row={editing} onClose={() => setEditing(null)} onSaved={refresh} />
      <AdjustModal row={adjusting} onClose={() => setAdjusting(null)} onSaved={refresh} />
    </>
  );
}

function EditMemberModal({
  row, onClose, onSaved,
}: { row: LeaveBalanceRow | null; onClose: () => void; onSaved: () => void }) {
  const [rate, setRate] = useState('');
  const [joined, setJoined] = useState('');
  const [saturday, setSaturday] = useState<'inherit' | 'on' | 'off'>('inherit');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!row) return;
    setRate(row.accrualDays === null ? '' : String(row.accrualDays));
    setJoined(row.joinedOnSet ? row.accrualStart : '');
    setSaturday(row.lastSaturdayOff === null ? 'inherit' : row.lastSaturdayOff ? 'on' : 'off');
    setError(null);
  }, [row]);

  const save = useMutation({
    mutationFn: () =>
      api(`/v1/admin/leave/members/${row!.userId}`, {
        method: 'PATCH',
        json: {
          accrualDays: rate.trim() === '' ? null : Number(rate),
          joinedOn: joined.trim() === '' ? null : joined,
          lastSaturdayOff: saturday === 'inherit' ? null : saturday === 'on',
        },
      }),
    onSuccess: () => { onSaved(); onClose(); },
    onError: (e: Error) => setError(humanError(e.message)),
  });

  return (
    <Modal
      open={row !== null}
      onClose={onClose}
      title={row ? `Leave settings — ${row.name}` : ''}
      description="These decide what the balance becomes. The balance itself is the sum of the ledger, so to move it, post an adjustment instead."
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>Save</Button>
        </>
      }
    >
      {error && <Banner status="danger">{error}</Banner>}
      <Field label="Monthly grant (days)" hint="Leave empty to inherit the workspace policy.">
        <Input type="number" step="0.5" min="0" value={rate} placeholder="inherit"
               onChange={(e) => setRate(e.target.value)} />
      </Field>
      <Field label="Accrues from" hint="Their joining date. Empty falls back to the Timo account date.">
        <Input type="date" value={joined} onChange={(e) => setJoined(e.target.value)} />
      </Field>
      <Field label="Last Saturday of the month">
        <Select value={saturday} onChange={(e) => setSaturday(e.target.value as typeof saturday)}>
          <option value="inherit">Inherit workspace policy</option>
          <option value="on">Not a working day</option>
          <option value="off">A normal working day</option>
        </Select>
      </Field>
    </Modal>
  );
}

function AdjustModal({
  row, onClose, onSaved,
}: { row: LeaveBalanceRow | null; onClose: () => void; onSaved: () => void }) {
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setAmount(''); setError(null); }, [row]);

  const save = useMutation({
    mutationFn: () =>
      api('/v1/admin/leave/adjust', {
        method: 'POST',
        json: {
          userId: row!.userId,
          days: Number(amount),
          effectiveOn: new Date().toISOString().slice(0, 10),
        },
      }),
    onSuccess: () => { onSaved(); onClose(); },
    onError: (e: Error) => setError(humanError(e.message)),
  });

  const valid = amount.trim() !== '' && Number(amount) !== 0;

  return (
    <Modal
      open={row !== null}
      onClose={onClose}
      title={row ? `Adjust balance — ${row.name}` : ''}
      description="Written as a ledger entry, so their statement explains how the number got there."
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button disabled={!valid || save.isPending} onClick={() => save.mutate()}>Post adjustment</Button>
        </>
      }
    >
      {error && <Banner status="danger">{error}</Banner>}
      {row && (
        <Banner status="info">
          Balance is {days(row.balanceDays)} today
          {amount.trim() !== '' && !Number.isNaN(Number(amount)) && (
            <> — this makes it {days(row.balanceDays + Number(amount))}.</>
          )}
        </Banner>
      )}
      <Field label="Days" hint="Negative takes days away. Half days allowed.">
        <Input type="number" step="0.5" value={amount} placeholder="e.g. 1 or -0.5"
               onChange={(e) => setAmount(e.target.value)} />
      </Field>
    </Modal>
  );
}
