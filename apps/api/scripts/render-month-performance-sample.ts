/**
 * Render a synthetic month performance report to disk, so the layout can be
 * eyeballed against the source attendance report without a database. Dev tool.
 *
 *   pnpm --filter @grind/api exec tsx scripts/render-month-performance-sample.ts <outDir>
 */
import { writeFileSync } from 'node:fs';
import type { DayStatus, WorkingDayKind } from '@grind/types';
import type { PunchLookup } from '../src/attendance/punches';
import {
  buildMonthPerformance,
  formatMonthPerformanceCsv,
  type MonthPerformanceUser,
} from '../src/reports/monthPerformance';
import { monthPerformanceXlsx } from '../src/reports/monthPerformanceXlsx';

const outDir = process.argv[2] ?? '.';
const MONTH = '2026-08';

const users: MonthPerformanceUser[] = [
  { id: 'u1', name: 'Sujeet Kar', email: 'sujeet@emiactech.com', teamName: 'Technical' },
  { id: 'u2', name: 'Sakshi Agarwal', email: 'sakshi@emiactech.com', teamName: 'Technical' },
];

function status(date: string, kind: WorkingDayKind, over: Partial<DayStatus> = {}): DayStatus {
  const away = kind === 'HOLIDAY' || kind === 'PAID_LEAVE' || kind === 'UNPAID_LEAVE';
  return {
    date, kind,
    portion: away ? 'FULL' : null,
    paid: kind === 'HOLIDAY' || kind === 'PAID_LEAVE',
    chargedDays: kind === 'PAID_LEAVE' ? 1 : 0,
    expectedFraction: away ? 0 : kind === 'WORKING' ? 1 : 0,
    shiftName: 'General', label: null, ...over,
  };
}

const dayOfWeek = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

const dayStatusFor = (userId: string, date: string): DayStatus => {
  if (dayOfWeek(date) === 0) return status(date, 'WEEKLY_OFF');
  if (date === '2026-08-15') return status(date, 'HOLIDAY', { label: 'Independence Day' });
  if (userId === 'u2') {
    if (date === '2026-08-11') return status(date, 'PAID_LEAVE', { label: 'Paid leave' });
    if (date === '2026-08-25') return status(date, 'UNPAID_LEAVE', { label: 'Unpaid leave' });
    if (date === '2026-08-19') {
      return status(date, 'PAID_LEAVE', {
        portion: 'FIRST_HALF', expectedFraction: 0.5, chargedDays: 0.5, label: 'Paid leave',
      });
    }
  }
  return status(date, 'WORKING');
};

/** A plausible spread: steady punches for u1, gaps and open punches for u2. */
const punchFor: PunchLookup = (userId, date) => {
  const d = Number.parseInt(date.slice(8, 10), 10);
  if (dayOfWeek(date) === 0) return null;
  if (userId === 'u2') {
    if (d % 6 === 0) return null;                                    // no punch at all
    if (d % 9 === 0) return { inMinute: 10 * 60 + 26, outMinute: null }; // forgot to punch out
    if (d === 22) return { inMinute: 9 * 60 + 28, outMinute: 22 * 60 + 11 }; // long overtime day
  }
  return { inMinute: 9 * 60 + 27 + (d % 5) * 7, outMinute: 18 * 60 + 12 + (d % 4) * 11 };
};

const report = buildMonthPerformance({
  month: MONTH,
  tz: 'Asia/Kolkata',
  companyName: 'EMIAC TECHNOLOGIES PRIVATE LIMITED',
  users,
  dayStatusFor,
  punchFor,
  generatedAtMs: Date.UTC(2026, 8, 1),
});

writeFileSync(`${outDir}/month-performance-${MONTH}.csv`, formatMonthPerformanceCsv(report));
monthPerformanceXlsx(report).then((buf) => {
  writeFileSync(`${outDir}/month-performance-${MONTH}.xlsx`, buf);
  console.log('wrote csv + xlsx to', outDir);
});
