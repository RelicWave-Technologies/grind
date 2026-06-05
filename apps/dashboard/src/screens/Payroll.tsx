import './payroll.css';
import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, FileSpreadsheet } from 'lucide-react';
import { api, API_BASE } from '../lib/api';
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
  Identity,
  Avatar,
  Tag,
  Toolbar,
  DateStepper,
  Button,
  Banner,
  EmptyState,
  SkeletonTable,
  SkeletonStat,
} from '../ui';

/**
 * /payroll — ADMIN monthly payroll worksheet (M15).
 *
 * Picks a month, previews per-user totals (days present, hours by kind), and
 * downloads a CSV via /v1/admin/payroll/monthly.csv. Composed entirely from the
 * shared "Quiet Datasheet" kit (see src/ui/SYSTEM.md): PageHeader + Toolbar for
 * the month stepper and CSV download, a flush StatRow for the period headline
 * numbers, and a flush Table for the per-user ledger with an accent-railed TOTAL
 * row. No bespoke component styling — tokens + kit only.
 */

interface PayrollRow {
  user: {
    id: string;
    name: string;
    email: string;
    role: string;
    teamName: string | null;
  };
  daysPresent: number;
  workedHours: number;
  meetingHours: number;
  manualHours: number;
  totalHours: number;
  avgDayHours: number;
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
  };
}

function thisMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map((n) => Number.parseInt(n, 10));
  if (!y || !m) return month;
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

function fmtMonth(month: string): string {
  const [y, m] = month.split('-').map((n) => Number.parseInt(n, 10));
  if (!y || !m) return month;
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(
    new Date(Date.UTC(y, m - 1, 1)),
  );
}

export function PayrollScreen() {
  const [month, setMonth] = useState<string>(thisMonth());
  const [downloading, setDownloading] = useState(false);
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', []);

  const q = useQuery({
    queryKey: ['admin', 'payroll', month, tz],
    queryFn: () => api<MonthlyPayroll>(`/v1/admin/payroll/monthly?month=${month}&tz=${tz}`),
  });

  async function downloadCsv() {
    // Cross-origin fetch + Blob so the auth cookie travels and we can
    // suggest a sane filename. Native <a download> wouldn't pick up the
    // Content-Disposition header in a cross-origin context.
    setDownloading(true);
    try {
      const res = await fetch(
        `${API_BASE}/v1/admin/payroll/monthly.csv?month=${month}&tz=${tz}`,
        { credentials: 'include' },
      );
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

  const isCurrent = month === thisMonth();
  const peopleCount = q.data?.rows.length ?? 0;
  const totals = q.data?.totals;
  const hasRows = (q.data?.rows.length ?? 0) > 0;

  return (
    <Page>
      <PageHeader
        eyebrow={`Payroll · ${tz.replace(/_/g, ' ')}`}
        title={fmtMonth(month)}
        subtitle="Monthly hours summary, ready for finance — worked, meeting, manual and total hours per person."
        actions={
          <Toolbar>
            {!isCurrent && (
              <Button variant="ghost" size="sm" onClick={() => setMonth(thisMonth())}>
                Today
              </Button>
            )}
            <DateStepper
              value={fmtMonth(month)}
              onPrev={() => setMonth((m) => shiftMonth(m, -1))}
              onNext={() => setMonth((m) => shiftMonth(m, 1))}
              nextDisabled={isCurrent}
              prevLabel="Previous month"
              nextLabel="Next month"
            />
            <Button
              variant="primary"
              icon={<Download size={15} strokeWidth={2} />}
              onClick={downloadCsv}
              loading={downloading}
              disabled={!hasRows}
            >
              Download CSV
            </Button>
          </Toolbar>
        }
      />

      {q.isError ? (
        <Banner
          status="danger"
          className="pay-block"
          action={
            <Button variant="ghost" size="sm" onClick={() => q.refetch()}>
              Retry
            </Button>
          }
        >
          Couldn&apos;t load the payroll worksheet: {(q.error as Error).message}
        </Banner>
      ) : (
        <>
          {/* Period headline numbers. */}
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
                <Stat
                  label="People"
                  value={peopleCount}
                  hint={peopleCount === 0 ? 'nobody to bill yet' : 'in this worksheet'}
                />
                <Stat
                  label="Total hours"
                  value={totals.totalHours.toFixed(1)}
                  unit="h"
                  hint={
                    totals.meetingHours > 0
                      ? `incl. ${totals.meetingHours.toFixed(1)}h meetings`
                      : 'across all people'
                  }
                />
                <Stat label="Days present" value={totals.daysPresent} hint="person-days logged" />
                <Stat
                  label="Manual hours"
                  value={totals.manualHours.toFixed(1)}
                  unit="h"
                  hint={totals.manualHours === 0 ? 'no manual edits' : 'manually entered'}
                />
              </StatRow>
            )}
          </Card>

          {/* Per-user worksheet. */}
          <Card variant="flush" className="pay-block">
            {q.isLoading ? (
              <SkeletonTable rows={6} />
            ) : !hasRows ? (
              <EmptyState
                icon={<FileSpreadsheet size={22} strokeWidth={1.8} />}
                title="No users in this workspace yet"
                description="Once people start tracking time, their monthly totals will appear here ready to export."
              />
            ) : (
              <div className="pay-scroll">
                <Table>
                  <THead>
                    <Tr>
                      <Th>Name</Th>
                      <Th>Role</Th>
                      <Th>Team</Th>
                      <Th align="right">Days</Th>
                      <Th align="right">Worked</Th>
                      <Th align="right">Meetings</Th>
                      <Th align="right">Manual</Th>
                      <Th align="right">Total</Th>
                      <Th align="right">Avg / day</Th>
                    </Tr>
                  </THead>
                  <Tbody>
                    {q.data!.rows.map((r) => (
                      <Tr key={r.user.id}>
                        <Td>
                          <Identity
                            name={r.user.name}
                            subtitle={r.user.email}
                            avatar={<Avatar name={r.user.name} size={32} />}
                          />
                        </Td>
                        <Td>
                          <Tag mono>{r.user.role}</Tag>
                        </Td>
                        <Td>
                          {r.user.teamName ? (
                            <Tag>{r.user.teamName}</Tag>
                          ) : (
                            <span className="ui-t-small">—</span>
                          )}
                        </Td>
                        <Td mono>{r.daysPresent}</Td>
                        <Td mono>{r.workedHours.toFixed(2)}</Td>
                        <Td mono>{r.meetingHours.toFixed(2)}</Td>
                        <Td mono>{r.manualHours.toFixed(2)}</Td>
                        <Td mono>{r.totalHours.toFixed(2)}</Td>
                        <Td mono>{r.avgDayHours.toFixed(2)}</Td>
                      </Tr>
                    ))}
                    <Tr rail="accent">
                      <Td className="ui-t-eyebrow">Total</Td>
                      <Td />
                      <Td />
                      <Td mono>{totals!.daysPresent}</Td>
                      <Td mono>{totals!.workedHours.toFixed(2)}</Td>
                      <Td mono>{totals!.meetingHours.toFixed(2)}</Td>
                      <Td mono>{totals!.manualHours.toFixed(2)}</Td>
                      <Td mono>{totals!.totalHours.toFixed(2)}</Td>
                      <Td mono>—</Td>
                    </Tr>
                  </Tbody>
                </Table>
              </div>
            )}
          </Card>
        </>
      )}
    </Page>
  );
}
