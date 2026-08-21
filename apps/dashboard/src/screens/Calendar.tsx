import './calendar.css';
import { useMemo, useState } from 'react';
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
  const [tab, setTab] = useState<'month' | 'holidays' | 'mine'>('month');

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
      />

      <StatRow>
        <Stat
          label="Your balance"
          value={balance ? days(balance.balanceDays) : '—'}
          unit="days"
          hint={policy ? `Accrues ${days(policy.policy.monthlyAccrualDays)} a month` : undefined}
        />
        <Stat label="Accrued" value={balance ? days(balance.accruedDays) : '—'} unit="days" />
        <Stat label="Used" value={balance ? days(balance.consumedDays) : '—'} unit="days" />
        <Stat label="Holidays" value={data ? String(data.holidays.length) : '—'} hint="this month" />
        <Stat
          label="Days away"
          value={data ? days(awayCount) : '—'}
          hint="across everyone"
        />
      </StatRow>

      <Tabs
        items={[
          { value: 'month' as const, label: 'Month' },
          { value: 'holidays' as const, label: 'Company holidays' },
          { value: 'mine' as const, label: 'My leave' },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'month' && (
        <Card>
          <div className="cal-monthbar">
            <div>
              <span className="cal-month">{monthName(month)}</span>
              <span className="cal-month__year">{month.slice(0, 4)}</span>
            </div>
            <Toolbar>
              <IconButton
                aria-label="Previous month"
                icon={<ChevronLeft />}
                onClick={() => setMonth(shiftMonth(month, -1))}
              />
              <Button variant="secondary" onClick={() => setMonth(today.slice(0, 7))}>
                Today
              </Button>
              <IconButton
                aria-label="Next month"
                icon={<ChevronRight />}
                onClick={() => setMonth(shiftMonth(month, 1))}
              />
            </Toolbar>
          </div>

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

      {tab === 'mine' && (
        <MyLeavePanel
          requests={mineQ.data?.requests ?? []}
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
  loading,
  statement,
  decidedInLark,
}: {
  requests: LeaveRequestDto[];
  loading: boolean;
  statement: LeaveBalanceResponse['statement'];
  decidedInLark: boolean;
}) {
  return (
    <>
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
