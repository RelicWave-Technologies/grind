/**
 * Tiny time/duration formatters for the dashboard. Match the agent's
 * conventions (12h clock, "Xh Ym", "·" separators) so an employee
 * switching between the desktop tracker and the web dashboard sees
 * the same numbers in the same shape.
 */

export function fmtTime(ms: number, tz?: string): string {
  const opts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  if (tz) opts.timeZone = tz;
  return new Intl.DateTimeFormat(undefined, opts).format(new Date(ms));
}

export function fmtRange(startMs: number, endMs: number, tz?: string): string {
  return `${fmtTime(startMs, tz)} – ${fmtTime(endMs, tz)}`;
}

export function fmtDurationMs(ms: number): string {
  if (ms <= 0) return '0m';
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** Today / Yesterday / "Sat, May 30". */
export function fmtDayLabel(yyyyMmDd: string): string {
  const today = new Date();
  const todayKey = today.toISOString().slice(0, 10);
  if (yyyyMmDd === todayKey) return 'Today';
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  if (yyyyMmDd === yesterday.toISOString().slice(0, 10)) return 'Yesterday';
  const d = new Date(`${yyyyMmDd}T00:00:00`);
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(d);
}

/** Shift a YYYY-MM-DD string by a number of calendar days. */
export function addDays(yyyyMmDd: string, delta: number): string {
  const d = new Date(`${yyyyMmDd}T00:00:00`);
  d.setDate(d.getDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}
