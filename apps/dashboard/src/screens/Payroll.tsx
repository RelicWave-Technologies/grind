import './payroll.css';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { useRouteContext } from '@tanstack/react-router';
import { Download, FileSpreadsheet, X } from 'lucide-react';
import { api, API_BASE } from '../lib/api';
import { dateKeyInTimeZone, instantForZonedDateTime } from '@grind/types';
import {
  Avatar,
  Banner,
  Button,
  Card,
  DateStepper,
  EmptyState,
  IconButton,
  Identity,
  Page,
  PageHeader,
  SkeletonStat,
  SkeletonTable,
  Stat,
  StatRow,
  Table,
  Tag,
  Tbody,
  Td,
  Th,
  THead,
  Toolbar,
  Tr,
} from '../ui';

interface PayrollPolicyDto {
  halfDayLowerMin: number;
  halfDayUpperMin: number;
  fullDayLowerMin: number;
  fullDayUpperMin: number;
  monthlyLowerMin: number;
  timezone: string;
  approvalReminderDays: number[];
  approvalReminderTime: string;
  payrollSheetSendDay: number;
  payrollSheetSendTime: string;
  sendPayrollSheetTo: 'all_admins';
  updatedAt: string;
}

type PayrollDayStatus = 'FULL' | 'HALF' | 'OFF' | 'SCHEDULED_OFF' | 'NO_SHIFT';

interface PayrollDay {
  date: string;
  rawMs: number;
  cappedMs: number;
  ignoredOverflowMs: number;
  eligible: boolean;
  shiftName: string | null;
  status: PayrollDayStatus;
  directStatus: PayrollDayStatus;
  reason: string;
  carryInMs: number;
  carryOutMs: number;
}

interface PayrollRow {
  user: {
    id: string;
    name: string;
    email: string;
    avatarUrl: string | null;
    role: string;
    teamName: string | null;
  };
  daysPresent: number;
  workedHours: number;
  meetingHours: number;
  manualHours: number;
  totalHours: number;
  avgDayHours: number;
  rawHours: number;
  cappedHours: number;
  ignoredOverflowHours: number;
  eligibleDays: number;
  fullDays: number;
  halfDays: number;
  offDays: number;
  scheduledOffDays: number;
  noShiftDays: number;
  payableUnits: number;
  monthlyGuarantee: boolean;
  payrollDays: PayrollDay[];
}

interface PayrollRunLogDto {
  id: string;
  runType: 'APPROVAL_REMINDER' | 'PAYROLL_SHEET';
  scheduledFor: string;
  status: 'SENT' | 'PARTIAL' | 'FAILED' | 'SKIPPED';
  sentCount: number;
  skippedNoLarkCount: number;
  skippedUnassignedCount: number;
  failedCount: number;
  createdAt: string;
}

interface MonthlyPayroll {
  month: string;
  tz: string;
  generatedAtMs: number;
  rows: PayrollRow[];
  totals: {
    daysPresent: number;
    workedHours: number;
    meetingHours: number;
    manualHours: number;
    totalHours: number;
    rawHours: number;
    cappedHours: number;
    ignoredOverflowHours: number;
    eligibleDays: number;
    fullDays: number;
    halfDays: number;
    offDays: number;
    payableUnits: number;
  };
}

interface PayrollPayload {
  payroll: MonthlyPayroll;
  policy: PayrollPolicyDto;
  runs: PayrollRunLogDto[];
  unresolvedApprovalCount: number;
}

function thisMonth(timeZone: string): string {
  return dateKeyInTimeZone(new Date(), timeZone).slice(0, 7);
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map((n) => Number.parseInt(n, 10));
  if (!y || !m) return month;
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

function fmtMonth(month: string, timeZone: string): string {
  const [y, m] = month.split('-').map((n) => Number.parseInt(n, 10));
  if (!y || !m) return month;
  const instant = instantForZonedDateTime({ year: y, month: m, day: 1, hour: 12, minute: 0, second: 0 }, timeZone);
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone }).format(instant);
}

function formatPayrollDay(date: string, timeZone: string): string {
  const [year, month, day] = date.split('-').map((part) => Number.parseInt(part, 10));
  const instant = instantForZonedDateTime({ year: year!, month: month!, day: day!, hour: 12, minute: 0, second: 0 }, timeZone);
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone,
  }).format(instant);
}

function h(min: number): string {
  const hours = Math.floor(min / 60);
  const mins = min % 60;
  if (hours && mins) return `${hours}h ${mins}m`;
  if (hours) return `${hours}h`;
  return `${mins}m`;
}

function msToTime(ms: number): string {
  return h(Math.round(ms / 60_000));
}

function statusTone(status: PayrollDayStatus): 'success' | 'warn' | 'danger' | 'neutral' {
  if (status === 'FULL') return 'success';
  if (status === 'HALF') return 'warn';
  if (status === 'OFF') return 'danger';
  return 'neutral';
}

function statusLabel(status: PayrollDayStatus): string {
  if (status === 'SCHEDULED_OFF') return 'Scheduled off';
  if (status === 'NO_SHIFT') return 'No shift';
  return status[0] + status.slice(1).toLowerCase();
}

export function PayrollScreen() {
  const { me } = useRouteContext({ from: '/authed' });
  const timeZone = me.workspaceTimezone;
  const [month, setMonth] = useState<string>(() => thisMonth(timeZone));
  const [downloading, setDownloading] = useState(false);
  const [selectedRow, setSelectedRow] = useState<PayrollRow | null>(null);

  const q = useQuery({
    queryKey: ['admin', 'payroll', month],
    queryFn: () => api<PayrollPayload>(`/v1/admin/payroll/monthly?month=${month}`),
  });

  const policy = q.data?.policy;
  const payroll = q.data?.payroll;
  const totals = payroll?.totals;
  const hasRows = (payroll?.rows.length ?? 0) > 0;
  const isCurrent = month === thisMonth(timeZone);

  async function downloadCsv() {
    setDownloading(true);
    try {
      const res = await fetch(`${API_BASE}/v1/admin/payroll/monthly.csv?month=${month}`, { credentials: 'include' });
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `grind-payroll-${month}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Page>
      <PageHeader
        eyebrow={`Payroll · ${policy?.timezone ?? timeZone}`}
        title={fmtMonth(month, timeZone)}
        subtitle="Classify shift-working days as Full, Half, or Off and prepare the Lark month-close worksheet."
        actions={
          <Toolbar>
            {!isCurrent && (
              <Button variant="ghost" size="sm" onClick={() => setMonth(thisMonth(timeZone))}>
                Today
              </Button>
            )}
            <DateStepper
              value={fmtMonth(month, timeZone)}
              onPrev={() => setMonth((m) => shiftMonth(m, -1))}
              onNext={() => setMonth((m) => shiftMonth(m, 1))}
              nextDisabled={isCurrent}
              prevLabel="Previous month"
              nextLabel="Next month"
            />
            <Button variant="secondary" icon={<Download size={15} strokeWidth={2} />} onClick={downloadCsv} loading={downloading} disabled={!hasRows}>
              CSV
            </Button>
          </Toolbar>
        }
      />

      {q.isError ? (
        <Banner status="danger" className="pay-block" action={<Button variant="ghost" size="sm" onClick={() => q.refetch()}>Retry</Button>}>
          Couldn&apos;t load payroll: {(q.error as Error).message}
        </Banner>
      ) : (
        <>
          <Card variant="flush" className="pay-block">
            {q.isLoading || !totals ? (
              <div className="pay-stat-skel">
                <SkeletonStat />
                <SkeletonStat />
                <SkeletonStat />
                <SkeletonStat />
              </div>
            ) : (
              <StatRow>
                <Stat label="Payable units" value={totals.payableUnits.toFixed(1)} hint={`${totals.fullDays} full · ${totals.halfDays} half · ${totals.offDays} off`} />
                <Stat label="Capped hours" value={totals.cappedHours.toFixed(1)} unit="h" hint={`${totals.ignoredOverflowHours.toFixed(1)}h overflow ignored`} />
                <Stat label="Eligible days" value={totals.eligibleDays} hint="shift working days only" />
                <Stat label="Pending approvals" value={q.data?.unresolvedApprovalCount ?? 0} hint="can affect payroll" />
              </StatRow>
            )}
          </Card>

          <Card variant="flush" className="pay-block">
            {q.isLoading ? (
              <SkeletonTable rows={6} />
            ) : !hasRows ? (
              <EmptyState
                icon={<FileSpreadsheet size={22} strokeWidth={1.8} />}
                title="No payroll rows yet"
                description="Rows appear when workspace members exist. No-shift days are excluded from payable-day classification."
              />
            ) : (
              <div className="pay-scroll">
                <Table className="pay-table">
                  <THead>
                    <Tr>
                      <Th>User</Th>
                      <Th>Team</Th>
                      <Th align="right">Raw</Th>
                      <Th align="right">Capped</Th>
                      <Th align="center">Days</Th>
                      <Th align="right">Units</Th>
                      <Th>Warnings</Th>
                      <Th align="center">Open</Th>
                    </Tr>
                  </THead>
                  <Tbody>
                    {payroll!.rows.map((r) => (
                      <Tr key={r.user.id}>
                        <Td>
                          <Identity name={r.user.name} subtitle={r.user.email} avatar={<Avatar name={r.user.name} src={r.user.avatarUrl ?? undefined} size={32} />} />
                        </Td>
                        <Td>{r.user.teamName ? <Tag>{r.user.teamName}</Tag> : <span className="ui-t-small">-</span>}</Td>
                        <Td mono>{r.rawHours.toFixed(1)}h</Td>
                        <Td mono>{r.cappedHours.toFixed(1)}h</Td>
                        <Td align="center">
                          <div className="pay-day-pills">
                            <Tag status="success" mono>{r.fullDays}F</Tag>
                            <Tag status="warn" mono>{r.halfDays}H</Tag>
                            <Tag status="danger" mono>{r.offDays}O</Tag>
                          </div>
                        </Td>
                        <Td mono>{r.payableUnits.toFixed(1)}</Td>
                        <Td>
                          <div className="pay-warning-stack">
                            {r.noShiftDays > 0 && <Tag status="neutral" mono>{r.noShiftDays} no shift</Tag>}
                            {r.ignoredOverflowHours > 0 && <Tag status="warn" mono>{r.ignoredOverflowHours.toFixed(1)}h ignored</Tag>}
                            {r.monthlyGuarantee && <Tag status="success" mono>monthly met</Tag>}
                            {r.noShiftDays === 0 && r.ignoredOverflowHours === 0 && !r.monthlyGuarantee && <span className="ui-t-small">-</span>}
                          </div>
                        </Td>
                        <Td align="center">
                          <Button size="sm" variant="secondary" onClick={() => setSelectedRow(r)}>Ledger</Button>
                        </Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
              </div>
            )}
          </Card>
        </>
      )}

      {selectedRow && <PayrollDrawer row={selectedRow} month={month} timeZone={timeZone} onClose={() => setSelectedRow(null)} />}
    </Page>
  );
}

function PayrollDrawer({ row, month, timeZone, onClose }: { row: PayrollRow; month: string; timeZone: string; onClose: () => void }) {
  const drawer = (
    <div className="pay-drawer-layer" role="presentation" onMouseDown={onClose}>
      <aside className="pay-drawer" role="dialog" aria-modal="true" aria-labelledby="pay-drawer-title" onMouseDown={(e) => e.stopPropagation()}>
        <header className="pay-drawer-head">
          <div className="pay-drawer-title">
            <Avatar name={row.user.name} src={row.user.avatarUrl ?? undefined} size={40} />
            <div className="pay-drawer-heading">
              <span className="ui-t-eyebrow">Payroll ledger</span>
              <h2 id="pay-drawer-title">{row.user.name}</h2>
              <p>{row.user.teamName ?? 'No team'} · {month}</p>
            </div>
          </div>
          <IconButton aria-label="Close" icon={<X size={18} />} onClick={onClose} />
        </header>
        <div className="pay-drawer-body">
          <section className="pay-drawer-summary" aria-label="Payroll summary">
            <DrawerMetric label="Raw" value={`${row.rawHours.toFixed(1)}h`} hint="worked + meeting + approved manual" />
            <DrawerMetric label="Capped" value={`${row.cappedHours.toFixed(1)}h`} hint={`${row.ignoredOverflowHours.toFixed(1)}h overflow ignored`} />
            <DrawerMetric label="Units" value={row.payableUnits.toFixed(1)} hint={`${row.fullDays} full · ${row.halfDays} half · ${row.offDays} off`} />
            <DrawerMetric label="Eligible" value={row.eligibleDays.toString()} hint="shift working days only" />
          </section>
          <Card variant="flush" title="Day ledger" action={<Tag mono>{row.eligibleDays} eligible</Tag>}>
            <div className="pay-ledger-wrap">
              <Table density="compact" stickyHead className="pay-ledger-table">
                <THead>
                  <Tr>
                    <Th>Date</Th>
                    <Th align="right">Raw</Th>
                    <Th align="right">Capped</Th>
                    <Th align="right">Carry</Th>
                    <Th align="center">Status</Th>
                    <Th>Note</Th>
                  </Tr>
                </THead>
                <Tbody>
                  {row.payrollDays.map((day) => (
                    <Tr key={day.date}>
                      <Td>
                        <div className="pay-date-cell">
                          <strong>{formatPayrollDay(day.date, timeZone)}</strong>
                          <span>{day.shiftName ?? 'No shift'}</span>
                        </div>
                      </Td>
                      <Td mono>{msToTime(day.rawMs)}</Td>
                      <Td mono>{msToTime(day.cappedMs)}</Td>
                      <Td mono>{day.carryInMs > 0 ? `+${msToTime(day.carryInMs)}` : day.carryOutMs > 0 ? `${msToTime(day.carryOutMs)} out` : '-'}</Td>
                      <Td align="center"><Tag status={statusTone(day.status)} mono>{statusLabel(day.status)}</Tag></Td>
                      <Td className="pay-note"><span className="ui-t-small">{day.ignoredOverflowMs > 0 ? `${msToTime(day.ignoredOverflowMs)} overflow ignored` : day.reason.replace(/_/g, ' ')}</span></Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </div>
          </Card>
          <Banner status="info">
            Carry credits are payroll audit only. They do not rewrite timesheets.
          </Banner>
        </div>
      </aside>
    </div>
  );

  return createPortal(drawer, document.body);
}

function DrawerMetric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="pay-drawer-metric">
      <span className="ui-t-eyebrow">{label}</span>
      <strong>{value}</strong>
      <span>{hint}</span>
    </div>
  );
}
