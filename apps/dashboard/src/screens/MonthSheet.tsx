import './monthSheet.css';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, ChevronLeft, ChevronRight, Undo2, X } from 'lucide-react';
import {
  DISPLAY_DAY_LABEL,
  type AttendanceOverrideHistoryResponse,
  type DisplayDayCode,
  type MonthSheetDay,
  type MonthSheetResponse,
  type MonthSheetRow,
} from '@grind/types';
import { api } from '../lib/api';
import { monthSheetQuery } from '../lib/queries';
import { personFacets, personSearchFields, useTableFilter } from '../lib/tableFilter';
import { fmtMonthLong } from '../lib/useMonthReportDownload';
import { Banner, Button, Card, EmptyState, FilterBar, IconButton, Input, NoMatches, SkeletonTable } from '../ui';

/**
 * The month performance sheet, on the page — drawn the way the Excel download
 * is, because that is the layout people already read without thinking.
 *
 * Per month: a masthead, then a block per person — the name with the month's
 * counts opposite it, the team and email with the leave account opposite
 * them, then the day axis and Office In, Office Out, Total Working Hours,
 * Status and Why. White page, no gridlines, small mono type, a hairline over
 * each block and whitespace between them; colour only in the Status row.
 * A range across months is one section per month, like one workbook each.
 *
 * Two things the paper cannot do:
 *   - **Screenshots.** Click a day's In, Out or Hours to open that day's
 *     screenshots and activity.
 *   - **Corrections.** Click a Status (shift for a run of days, ⌘ to add one),
 *     then pick P / HD / Leave / LWA with a reason in the bar that docks below.
 *     P H L A pick, Enter saves, Esc clears.
 *
 * Every value is the string the workbook prints (`/v1/reports/month-sheet`),
 * so what HR reads here is what they download.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

type Shape = 'P' | 'HALF_LEAVE' | 'FULL_LEAVE' | 'A';

/** What a correction may say — four shapes, never a paid/unpaid verdict. */
const SHAPES: ReadonlyArray<{ shape: Shape; code: DisplayDayCode; label: string; key: string }> = [
  { shape: 'P', code: 'P', label: 'Present', key: 'p' },
  { shape: 'HALF_LEAVE', code: 'HD', label: 'Half day', key: 'h' },
  { shape: 'FULL_LEAVE', code: 'L', label: 'Leave', key: 'l' },
  { shape: 'A', code: 'LWA', label: 'Absent', key: 'a' },
];

/** The code a day shows while its correction saves; the refetch settles PL vs L. */
const PROVISIONAL: Record<Shape, DisplayDayCode> = { P: 'P', HALF_LEAVE: 'HD', FULL_LEAVE: 'L', A: 'LWA' };

const QUICK_REASONS = ['Agent was down', 'Forgot to start Timo', 'Client visit', 'Approved by manager'];

const LEGEND: ReadonlyArray<DisplayDayCode> = ['P', 'HD', 'PL', 'L', 'LWA', 'HL', 'WO'];
/** Short enough to sit on one line; the full meaning is the tooltip. */
const LEGEND_SHORT: Record<DisplayDayCode, string> = {
  P: 'Present', HD: 'Half day', PL: 'Paid leave', L: 'Unpaid leave', LWA: 'No approval', HL: 'Holiday', WO: 'Week off', '--': 'No shift',
};

const STATUS_OPTIONS = (['P', 'HD', 'PL', 'L', 'LWA', 'HL', 'WO', '--'] as const).map((code) => ({
  value: code,
  label: `${code} — ${DISPLAY_DAY_LABEL[code]}`,
}));

function codeClass(code: string): string {
  return code === '--' ? 'none' : code.toLowerCase();
}

/** 'YYYY-MM' for every month from `from` to `to`, inclusive. */
function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number) as [number, number];
  const [ty, tm] = to.slice(0, 7).split('-').map(Number) as [number, number];
  while ((y < ty || (y === ty && m <= tm)) && out.length < 24) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/** "18 Sep" — the days in view. */
function shortDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function dayLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  });
}

const EMPTY_READING = new Set(['--:--', '00:00', '']);

type SheetPerson = MonthSheetRow & { codes: Set<string> };
type SheetDate = MonthSheetResponse['dates'][number] & { monthStart: boolean };
/** "08:12" — minutes as the sheet's own hours reading. */
function hhmm(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** A person across every month in range; `payable` is each month's own figure. */
type MergedRow = MonthSheetRow & { payable: Array<[string, string]> };

/** "1 Sep – 17 Oct 2026", or "October 2026" for exactly one whole month. */
function rangeLabel(from: string, to: string): string {
  const f = (d: string, o: Intl.DateTimeFormatOptions) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { ...o, timeZone: 'UTC' });
  return `${f(from, { day: 'numeric', month: 'short' })} – ${f(to, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export interface MonthSheetViewProps {
  from: string;
  to: string;
  /** May correct attendance at all. */
  canEdit: boolean;
  meId: string;
  isAdmin: boolean;
  /** Open a person's day — its screenshots and activity. */
  onOpenDay: (userId: string, date: string) => void;
}

interface Selection {
  userId: string;
  dates: string[];
}

export function MonthSheetView({ from, to, canEdit, meId, isAdmin, onOpenDay }: MonthSheetViewProps) {
  const qc = useQueryClient();
  const months = useMemo(() => monthsBetween(from, to), [from, to]);
  const results = useQueries({ queries: months.map((m) => monthSheetQuery<MonthSheetResponse>(m)) });
  const loading = results.some((r) => r.isLoading);
  const failed = results.find((r) => r.isError);
  /** Changes whenever any month's data does — an optimistic patch included. */
  const dataKey = results.map((r) => r.dataUpdatedAt).join(',');

  const sheets = useMemo(
    () => results.map((r) => r.data).filter((s): s is MonthSheetResponse => !!s),
    // `results` is a new array every render; `dataKey` says when its contents change.
    [dataKey],
  );
  // Everyone in any month, for the filter; the sheets themselves stay per month.
  const people = useMemo(() => {
    const byId = new Map<string, SheetPerson>();
    for (const sheet of sheets) {
      for (const row of sheet.rows) {
        const p = byId.get(row.userId) ?? { ...row, codes: new Set<string>() };
        for (const d of row.days) if (d.date >= from && d.date <= to) p.codes.add(d.code);
        byId.set(row.userId, p);
      }
    }
    return [...byId.values()];
  }, [sheets, from, to]);

  const filter = useTableFilter(
    people,
    {
      text: (p: SheetPerson) => personSearchFields(p),
      facets: {
        ...personFacets((p: SheetPerson) => p),
        status: { label: 'Statuses', value: (p: SheetPerson) => [...p.codes], options: STATUS_OPTIONS },
      },
    },
    { urlPrefix: 'sheet' },
  );
  const shownIds = useMemo(() => new Set(filter.rows.map((p) => p.userId)), [filter.rows]);

  // The months, laid end to end: one day axis for the whole range and one row
  // per person, so a range across months reads straight through.
  const merged = useMemo(() => {
    const dates: SheetDate[] = [];
    const rows = new Map<string, MergedRow>();
    for (const sheet of sheets) {
      for (const d of sheet.dates) {
        if (d.date >= from && d.date <= to) dates.push({ ...d, monthStart: dates.length > 0 && d.day === 1 });
      }
      for (const r of sheet.rows) {
        const pay = r.counts.find(([l]) => l === 'Payable Days')?.[1];
        const cur = rows.get(r.userId);
        if (!cur) {
          rows.set(r.userId, { ...r, days: [...r.days], payable: pay ? [[sheet.month, pay]] : [] });
        } else {
          cur.days.push(...r.days);
          cur.teamName = r.teamName;
          cur.unitName = r.unitName;
          cur.leave = r.leave; // the account as the range ends
          if (pay) cur.payable.push([sheet.month, pay]);
        }
      }
    }
    return { dates, rows: [...rows.values()], showWhy: sheets.some((s) => s.rulesFrom !== null) };
  }, [sheets, from, to]);

  // Names and labels stay pinned while the sheet scrolls sideways; the caption
  // wraps to the visible width, which only the browser knows.
  //
  // The page owns the vertical scroll. Sideways, the sheet scrolls as one, and
  // its scrollbar is a slim bar pinned to the foot of the window (kept in step
  // with the sheet), because the sheet's own would sit under the last person.
  const scrollRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  /**
   * What the toolbar shows about the scroll: which days are in view and whether
   * there is anywhere to go. Recomputed on scroll but only set when it changes,
   * so scrolling never re-renders the sheet.
   */
  const [view, setView] = useState({ first: 0, last: 0, width: 0, client: 0, atStart: true, atEnd: true });
  const dayCount = merged.dates.length;
  const LABEL_W = 128;
  const frame = useRef(0);
  const measure = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (!el || dayCount === 0) return;
      const dayW = Math.max(54, (el.scrollWidth - LABEL_W) / dayCount);
      const next = {
        first: Math.min(dayCount - 1, Math.max(0, Math.round(el.scrollLeft / dayW))),
        last: Math.min(dayCount - 1, Math.floor((el.scrollLeft + el.clientWidth - LABEL_W) / dayW) - 1),
        width: el.scrollWidth,
        client: el.clientWidth,
        atStart: el.scrollLeft <= 1,
        atEnd: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1,
      };
      setView((prev) =>
        (Object.keys(next) as Array<keyof typeof next>).every((k) => prev[k] === next[k]) ? prev : next,
      );
    });
  }, [dayCount]);
  const hasSheet = filter.rows.length > 0 && dayCount > 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [hasSheet, measure]);
  useEffect(measure, [dayCount, filter.rows.length, measure]);

  /**
   * Keep the sheet and the pinned bar together. Only the one being scrolled
   * leads: setting the other fires its own scroll event, and that echo is
   * ignored — otherwise each keeps correcting the other and the scroll judders.
   */
  const echo = useRef<HTMLElement | null>(null);
  const follow = (from: HTMLDivElement | null, to: HTMLDivElement | null) => {
    if (echo.current === from) { echo.current = null; return; }
    if (from && to && to.scrollLeft !== from.scrollLeft) {
      echo.current = to;
      to.scrollLeft = from.scrollLeft;
    }
    measure();
  };

  const overflowing = view.width > view.client + 1;
  const stepWeek = (dir: -1 | 1) => {
    const el = scrollRef.current;
    if (!el) return;
    const dayW = Math.max(54, (el.scrollWidth - LABEL_W) / dayCount);
    el.scrollBy({ left: dir * 7 * dayW, behavior: 'smooth' });
  };

  // --- selection + saving ---------------------------------------------------------
  const [selection, setSelection] = useState<Selection | null>(null);
  const anchor = useRef<string | null>(null);
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [shapeRequest, setShapeRequest] = useState<{ shape: Shape; n: number } | null>(null);

  // The server says whose days the caller may correct (HR: only her own team's).
  const canEditPerson = useCallback(
    (userId: string) => canEdit && !!sheets.some((s) => s.rows.some((r) => r.userId === userId && r.canEdit)),
    [canEdit, sheets],
  );

  const dayOf = useCallback(
    (userId: string, date: string) =>
      sheets.find((s) => s.month === date.slice(0, 7))?.rows.find((r) => r.userId === userId)?.days.find((d) => d.date === date),
    [sheets],
  );

  const onStatusClick = useCallback(
    (userId: string, date: string, e: React.MouseEvent) => {
      setSaveError(null);
      const from0 = anchor.current;
      setSelection((prev) => {
        const same = prev?.userId === userId;
        if (same && (e.metaKey || e.ctrlKey)) {
          const dates = prev.dates.includes(date) ? prev.dates.filter((d) => d !== date) : [...prev.dates, date];
          return dates.length ? { userId, dates } : null;
        }
        if (same && e.shiftKey && from0) {
          const [lo, hi] = from0 < date ? [from0, date] : [date, from0];
          const all = sheets.flatMap((s) => s.dates.map((d) => d.date));
          return { userId, dates: all.filter((d) => d >= lo && d <= hi && d >= from && d <= to) };
        }
        return { userId, dates: [date] };
      });
      if (!(e.shiftKey || e.metaKey || e.ctrlKey) || !from0) anchor.current = date;
    },
    [sheets, from, to],
  );

  const clearSelection = useCallback(() => {
    setSelection(null);
    anchor.current = null;
  }, []);

  // P / H / L / A pick, Esc clears — while something is selected.
  useEffect(() => {
    if (!selection) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { clearSelection(); return; }
      if ((e.target as HTMLElement | null)?.tagName === 'INPUT' || e.metaKey || e.ctrlKey || e.altKey) return;
      const shape = SHAPES.find((s) => s.key === e.key.toLowerCase());
      if (shape) {
        e.preventDefault();
        setShapeRequest((r) => ({ shape: shape.shape, n: (r?.n ?? 0) + 1 }));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selection, clearSelection]);

  /** Show the change at once; the refetch afterwards settles what the balance made of it. */
  function patchDay(userId: string, date: string, patch: (d: MonthSheetDay) => MonthSheetDay) {
    qc.setQueryData<MonthSheetResponse>(monthSheetQuery(date.slice(0, 7)).queryKey, (old) =>
      old && {
        ...old,
        rows: old.rows.map((r) => (r.userId !== userId ? r : { ...r, days: r.days.map((d) => (d.date === date ? patch(d) : d)) })),
      },
    );
  }

  async function save(action: 'set' | 'clear', shape: Shape, reason: string) {
    if (!selection) return;
    const { userId } = selection;
    const days = selection.dates
      .map((date) => dayOf(userId, date))
      .filter((d): d is MonthSheetDay => !!d && (action === 'set' || !!d.override));
    if (days.length === 0) return;
    setSaveError(null);
    setBusy({ done: 0, total: days.length });
    let done = 0;
    try {
      for (const day of days) {
        if (action === 'set') {
          patchDay(userId, day.date, (d) => ({ ...d, code: PROVISIONAL[shape], override: { code: shape, stale: false, reason } }));
          await api('/v1/reports/attendance-override', { method: 'PUT', json: { userId, date: day.date, code: shape, reason } });
        } else {
          patchDay(userId, day.date, (d) => ({ ...d, code: d.computed, override: null }));
          await api('/v1/reports/attendance-override', { method: 'DELETE', json: { userId, date: day.date, reason } });
        }
        done += 1;
        setBusy({ done, total: days.length });
      }
      clearSelection();
    } catch (err) {
      setSaveError(`${done} of ${days.length} saved. ${err instanceof Error ? err.message : 'The rest could not be saved.'}`);
    } finally {
      setBusy(null);
      void qc.invalidateQueries({ queryKey: ['reports'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'month-summary'] });
    }
  }

  // --- render ----------------------------------------------------------------------
  if (loading && sheets.length === 0) return <Card variant="flush"><SkeletonTable rows={8} /></Card>;
  if (failed) return <Banner status="danger">Couldn’t load the month sheet: {(failed.error as Error).message}</Banner>;
  if (people.length === 0) {
    return (
      <Card variant="flush">
        <EmptyState
          icon={<CalendarDays size={22} strokeWidth={1.8} />}
          title="No one in scope for these dates"
          description="The sheet lists everyone you can see who belonged here in the range."
        />
      </Card>
    );
  }

  const selectedPerson = selection ? people.find((p) => p.userId === selection.userId) : undefined;
  const selectedDays = selection
    ? selection.dates.map((date) => dayOf(selection.userId, date)).filter((d): d is MonthSheetDay => !!d)
    : [];

  // Which days are on screen, and a week back or forward.
  const dayNav = overflowing && merged.dates[view.first] && merged.dates[view.last] && (
    <div className="xl-nav" role="group" aria-label="Days in view">
      <IconButton
        size="sm"
        icon={<ChevronLeft size={15} strokeWidth={1.8} />}
        aria-label="Back a week"
        disabled={view.atStart}
        onClick={() => stepWeek(-1)}
      />
      <span className="xl-nav-range">
        {shortDate(merged.dates[view.first]!.date)} – {shortDate(merged.dates[view.last]!.date)}
      </span>
      <IconButton
        size="sm"
        icon={<ChevronRight size={15} strokeWidth={1.8} />}
        aria-label="Forward a week"
        disabled={view.atEnd}
        onClick={() => stepWeek(1)}
      />
    </div>
  );

  return (
    <Card variant="flush" className="xl">
      {/* One row, pinned to the top of the window while the sheet scrolls under it.
          A sheet of one person (your own) has nothing to search or filter. */}
      {people.length > 1 ? (
        <div className="xl-toolbar">
          {/* Search finds people, so the People and Roles pickers would only repeat it. */}
          <FilterBar filter={filter} placeholder="Search people…" hideFacets={['person', 'role']} plain>
            {dayNav}
          </FilterBar>
        </div>
      ) : (
        overflowing && <div className="xl-toolbar xl-toolbar--solo">{dayNav}</div>
      )}

      {filter.rows.length === 0 ? (
        <NoMatches onClear={filter.clear} />
      ) : (
        <section className="xl-month" aria-label="Month performance">
          <header className="xl-masthead">
            <div>
              <h2>Month Performance</h2>
              <p>{[sheets[0]?.companyName, rangeLabel(from, to), sheets[0]?.tz].filter(Boolean).join('   ·   ')}</p>
              <span className="xl-hint">
                Click a day’s hours to see its screenshots{canEdit ? ' · click a status to correct it' : ''}
              </span>
            </div>
            <ul className="xl-legend" aria-label="Status codes">
              {LEGEND.map((code) => (
                <li key={code} title={DISPLAY_DAY_LABEL[code]}>
                  <span className={`xl-key xl-s--${codeClass(code)}`}>{code}</span>
                  {LEGEND_SHORT[code]}
                </li>
              ))}
            </ul>
          </header>
          <div
            ref={scrollRef}
            className="xl-sheet"
            style={{ '--xl-view': view.client ? `${view.client}px` : '100%' } as CSSProperties}
            onScroll={() => follow(scrollRef.current, barRef.current)}
          >
            {merged.rows.filter((r) => shownIds.has(r.userId)).map((row) => (
              <PersonBlock
                key={row.userId}
                row={row}
                dates={merged.dates}
                showWhy={merged.showWhy}
                selected={selection?.userId === row.userId ? selection.dates : undefined}
                saving={!!busy && selection?.userId === row.userId}
                editable={canEditPerson(row.userId)}
                onStatusClick={onStatusClick}
                onOpenDay={onOpenDay}
              />
            ))}
          </div>
          {overflowing && (
            <div
              ref={barRef}
              className="xl-hbar"
              aria-hidden="true"
              onScroll={() => follow(barRef.current, scrollRef.current)}
            >
              <div style={{ width: view.width }} />
            </div>
          )}
        </section>
      )}

      {selection && selectedPerson && selectedDays.length > 0 &&
        createPortal(
          <EditBar
            key={`${selection.userId}|${selection.dates[0]}`}
            name={selectedPerson.name}
            userId={selection.userId}
            days={selectedDays}
            busy={busy}
            error={saveError}
            shapeRequest={shapeRequest}
            onSave={(action, shape, reason) => void save(action, shape, reason)}
            onClose={clearSelection}
          />,
          document.body,
        )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// One person's block — the workbook's, cell for cell
// ---------------------------------------------------------------------------

const PersonBlock = memo(function PersonBlock({
  row,
  dates,
  showWhy,
  selected,
  saving,
  editable,
  onStatusClick,
  onOpenDay,
}: {
  row: MergedRow;
  dates: SheetDate[];
  showWhy: boolean;
  selected: string[] | undefined;
  saving: boolean;
  editable: boolean;
  onStatusClick: (userId: string, date: string, e: React.MouseEvent) => void;
  onOpenDay: (userId: string, date: string) => void;
}) {
  const byDate = new Map(row.days.map((d) => [d.date, d]));
  const shown = dates.map((d) => byDate.get(d.date));

  // The strip opposite the name, counted over the days shown — the workbook's
  // own figures when the whole month is shown. Payable is the month's.
  const count = (code: string) => shown.filter((d) => d?.code === code).length;
  const sum = (pick: (d: MonthSheetDay) => number) => shown.reduce((t, d) => t + (d ? pick(d) : 0), 0);
  const workingDays = sum((d) => d.dayWeight);
  const counts: Array<[string, string]> = [
    ['Present', String(count('P'))],
    ['Half Day', String(count('HD'))],
    ['PL', String(count('PL'))],
    ['Leave', String(count('L'))],
    ['LWA', String(count('LWA'))],
    ['Late', String(shown.filter((d) => d?.late).length)],
    // Every hour shown, a Sunday worked included, over the days worked (P 1, HD ½, leave 0).
    ['Avg Hours', hhmm(workingDays === 0 ? 0 : sum((d) => d.workMinutes) / workingDays)],
    ['Manual Time', hhmm(sum((d) => d.manualMinutes))],
    // Payable is a month's figure, so a range across months gets one per month.
    ...row.payable.map(([month, v]): [string, string] =>
      [row.payable.length > 1 ? `Payable · ${fmtMonthLong(month).slice(0, 3)}` : 'Payable Days', v]),
  ];
  const months: Array<{ month: string; span: number }> = [];
  for (const d of dates) {
    const m = d.date.slice(0, 7);
    const last = months[months.length - 1];
    if (last?.month === m) last.span += 1; else months.push({ month: m, span: 1 });
  }
  const mo = (i: number) => (dates[i]!.monthStart ? ' is-mo' : '');
  const sel = new Set(selected);

  const reading = (key: 'officeIn' | 'officeOut' | 'work', label: string) => (
    <tr className="xl-reading">
      <th scope="row">{label}</th>
      {shown.map((d, i) => {
        const v = d?.[key] ?? '';
        const open = !!d && (d.workMinutes > 0 || !EMPTY_READING.has(d.officeIn));
        return (
          <td
            key={dates[i]!.date}
            className={`${EMPTY_READING.has(v) ? 'is-empty' : ''}${open ? ' is-open' : ''}${key === 'officeIn' && d?.late ? ' is-late' : ''}${mo(i)}`}
            onClick={open ? () => onOpenDay(row.userId, d.date) : undefined}
            title={open ? `${dayLabel(d.date)} — screenshots & activity` : undefined}
          >
            {v}
          </td>
        );
      })}
    </tr>
  );

  return (
    <article className="xl-block" aria-label={row.name}>
      <div className="xl-caption">
        <div className="xl-who">
          <h3>{row.name}</h3>
          <p>{[row.teamName, row.unitName, row.email].filter(Boolean).join('   ·   ')}</p>
        </div>
        <div className="xl-strips">
          <Strip pairs={counts} />
          {row.leave.length > 0 && <Strip pairs={row.leave} quiet />}
        </div>
      </div>

      <div className="xl-scroll">
        <table className="xl-grid" style={{ minWidth: 128 + dates.length * 54 }}>
          <colgroup>
            <col className="xl-col-label" />
            {dates.map((d) => <col key={d.date} />)}
          </colgroup>
          <thead>
            {months.length > 1 && (
              <tr className="xl-monthrow">
                <th />
                {months.map((m, i) => (
                  <th key={m.month} colSpan={m.span} className={i > 0 ? 'is-mo' : undefined}>{fmtMonthLong(m.month)}</th>
                ))}
              </tr>
            )}
            <tr className="xl-daynum">
              <th />
              {dates.map((d, i) => <th key={d.date} className={mo(i).trim() || undefined}>{d.day}</th>)}
            </tr>
            <tr className="xl-weekday">
              <th />
              {dates.map((d, i) => <th key={d.date} className={mo(i).trim() || undefined}>{d.weekday}</th>)}
            </tr>
          </thead>
          <tbody>
            {reading('officeIn', 'Office In')}
            {reading('officeOut', 'Office Out')}
            {reading('work', 'Total Working Hours')}
            <tr className="xl-status">
              <th scope="row">Status</th>
              {shown.map((d, i) => {
                const date = dates[i]!.date;
                if (!d) return <td key={date} className={`xl-s--none${mo(i)}`} />;
                const isSel = sel.has(date);
                const cls = `xl-s--${codeClass(d.code)}${isSel ? ' is-sel' : ''}${
                  d.override ? (d.override.stale ? ' is-fix is-stale' : ' is-fix') : ''}${saving && isSel ? ' is-saving' : ''}${editable ? ' is-edit' : ''}${mo(i)}`;
                const title = [
                  `${dayLabel(date)} — ${DISPLAY_DAY_LABEL[d.code as DisplayDayCode] ?? d.code}`,
                  d.label,
                  d.override
                    ? `Corrected by hand (computed: ${d.computed})${d.override.reason ? ` — “${d.override.reason}”` : ''}`
                    : null,
                  editable ? 'Click to correct' : null,
                ].filter(Boolean).join('\n');
                return (
                  <td key={date} className={cls} title={title} onClick={editable ? (e) => onStatusClick(row.userId, date, e) : undefined}>
                    {d.code}
                  </td>
                );
              })}
            </tr>
            {showWhy && (
              <tr className="xl-why">
                <th scope="row">Why</th>
                {shown.map((d, i) => (
                  <td key={dates[i]!.date} className={mo(i).trim() || undefined} title={d?.why || d?.label || undefined}>
                    {(d?.why ?? '').split(' · ').map((part) => <span key={part}>{part}</span>)}
                  </td>
                ))}
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </article>
  );
});

/** The count strip: a quiet label, then the figure it answers. */
function Strip({ pairs, quiet }: { pairs: ReadonlyArray<readonly [string, string]>; quiet?: boolean }) {
  return (
    <dl className={`xl-strip${quiet ? ' xl-strip--quiet' : ''}`}>
      {pairs.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------------------
// The correction bar, docked at the bottom of the window
// ---------------------------------------------------------------------------

function EditBar({
  name,
  userId,
  days,
  busy,
  error,
  shapeRequest,
  onSave,
  onClose,
}: {
  name: string;
  userId: string;
  days: MonthSheetDay[];
  busy: { done: number; total: number } | null;
  error: string | null;
  shapeRequest: { shape: Shape; n: number } | null;
  onSave: (action: 'set' | 'clear', shape: Shape, reason: string) => void;
  onClose: () => void;
}) {
  const single = days.length === 1 ? days[0]! : null;
  const corrected = days.filter((d) => d.override);
  const [shape, setShape] = useState<Shape | null>(single?.override ? (single.override.code as Shape) : null);
  // A corrected day opens with the reason it was corrected for, ready to keep or change.
  const [reason, setReason] = useState(single?.override?.reason ?? '');
  const reasonRef = useRef<HTMLInputElement>(null);
  const seenRequest = useRef(shapeRequest?.n ?? 0);

  // P / H / L / A from the page pick a shape and hand the keyboard to the reason.
  useEffect(() => {
    if (!shapeRequest || shapeRequest.n === seenRequest.current) return;
    seenRequest.current = shapeRequest.n;
    setShape(shapeRequest.shape);
    reasonRef.current?.focus();
  }, [shapeRequest]);

  const historyQ = useQuery({
    queryKey: ['attendance-override-history', userId, single?.date],
    enabled: !!single?.override,
    queryFn: () =>
      api<AttendanceOverrideHistoryResponse>(
        `/v1/reports/attendance-override/history?userId=${encodeURIComponent(userId)}&date=${single!.date}`,
      ),
  });
  const lastChange = historyQ.data?.entries[0];
  const ready = !!shape && reason.trim().length > 0 && !busy;

  return (
    <div className="xl-bar" role="dialog" aria-label="Correct selected days">
      <div className="xl-bar-top">
        <p>
          <strong>{name}</strong>
          {' · '}
          {single ? dayLabel(single.date) : `${days.length} days`}
          {single && (
            <span className="xl-bar-facts">
              {'  '}In {single.officeIn} · Out {single.officeOut} · {single.work} worked{single.why ? ` · ${single.why}` : ''}
            </span>
          )}
          {single?.override && (
            <span className="xl-bar-facts">
              {'  '}· corrected from {single.computed}
              {lastChange ? ` by ${lastChange.setByName ?? 'someone'} — “${lastChange.reason}”` : ''}
            </span>
          )}
        </p>
        <button type="button" className="xl-bar-close" onClick={onClose} aria-label="Clear selection (Esc)">
          <X size={15} strokeWidth={2} />
        </button>
      </div>
      <div className="xl-bar-row">
        <div className="xl-shapes" role="radiogroup" aria-label="Mark as">
          {SHAPES.map((s) => (
            <button
              key={s.shape}
              type="button"
              role="radio"
              aria-checked={shape === s.shape}
              className={`xl-shape${shape === s.shape ? ' is-on' : ''}`}
              onClick={() => { setShape(s.shape); reasonRef.current?.focus(); }}
              title={s.shape === 'FULL_LEAVE' ? 'PL when their leave balance pays for it, else L' : undefined}
            >
              <span className={`xl-key xl-s--${codeClass(s.code)}`}>{s.code}</span>
              {s.label}
              <kbd>{s.key.toUpperCase()}</kbd>
            </button>
          ))}
        </div>
        <Input
          ref={reasonRef}
          className="xl-reason"
          value={reason}
          placeholder="Reason (required)"
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && ready) onSave('set', shape!, reason.trim()); }}
        />
        <Button
          variant="primary"
          disabled={!ready}
          loading={!!busy}
          onClick={() => onSave('set', shape!, reason.trim())}
          title={!shape ? 'Pick P, HD, L or LWA' : reason.trim() ? undefined : 'Write a reason first'}
        >
          {busy ? `Saving ${busy.done}/${busy.total}` : days.length > 1 ? `Apply to ${days.length}` : 'Save'}
        </Button>
      </div>
      <div className="xl-bar-row xl-bar-row--quiet">
        <div className="xl-quick">
          {QUICK_REASONS.map((r) => (
            <button key={r} type="button" onClick={() => { setReason(r); reasonRef.current?.focus(); }}>{r}</button>
          ))}
        </div>
        {corrected.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Undo2 size={14} strokeWidth={2} />}
            disabled={!reason.trim() || !!busy}
            title={reason.trim() ? 'Go back to what the report computes' : 'Write a reason first'}
            onClick={() => onSave('clear', 'P', reason.trim())}
          >
            {corrected.length > 1 ? `Undo ${corrected.length} corrections` : 'Undo correction'}
          </Button>
        )}
      </div>
      {error && <p className="xl-bar-error" role="alert">{error}</p>}
    </div>
  );
}
