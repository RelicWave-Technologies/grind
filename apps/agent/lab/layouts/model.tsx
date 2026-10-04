/**
 * One made-up working day, shared by every layout option so they can be
 * compared like for like. Times are minutes from midnight on a fixed clock
 * (3:42 PM when the page opens, then running in real time), so the mock-ups
 * look the same whenever they are opened.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export type Kind = 'work' | 'meeting' | 'manual' | 'pending' | 'idle';
export type Mode = 'running' | 'paused' | 'idle';

export interface Block {
  entry: string;
  task: string;
  kind: Kind;
  start: number;
  /** null while it is the one being tracked right now. */
  end: number | null;
}

export interface Task {
  guid: string;
  summary: string;
  creator: string | null;
  /** Days from today; negative is overdue. */
  dueDays: number | null;
  completed: boolean;
}

export const ME = { name: 'Aarav Mehta', email: 'aarav.mehta@relicwave.test', initials: 'AM' };
export const SHIFT = { start: 9 * 60 + 30, end: 18 * 60 + 30, label: 'Day shift', range: '9:30 – 6:30' };
const OPENED_AT = 15 * 60 + 42;

export const TASKS: Task[] = [
  { guid: 'lab-task-01', summary: 'Floating bar: hover and pause states for the new timer pill', creator: 'Priya Nair', dueDays: 0, completed: false },
  { guid: 'lab-task-07', summary: 'Customer call prep — RelicWave Technologies', creator: 'Rahul Mehta', dueDays: 0, completed: false },
  { guid: 'lab-task-02', summary: 'Q3 client onboarding deck — review pricing slide with Rahul', creator: 'Rahul Mehta', dueDays: 1, completed: false },
  { guid: 'lab-task-03', summary: 'Investigate why screenshot uploads stall after the laptop wakes from sleep on flaky hotel Wi-Fi', creator: 'Aarav Mehta', dueDays: -2, completed: false },
  { guid: 'lab-task-05', summary: 'Design QA: People page on the dashboard', creator: 'Priya Nair', dueDays: 4, completed: false },
  { guid: 'lab-task-06', summary: 'Write the API reference for time entries (v1)', creator: 'Karan Shah', dueDays: 12, completed: false },
  { guid: 'lab-task-04', summary: 'Weekly sync notes → Lark doc', creator: 'Ananya Iyer', dueDays: null, completed: false },
  { guid: 'lab-task-08', summary: 'Tune idle detection thresholds for meetings', creator: null, dueDays: null, completed: false },
  { guid: 'lab-task-09', summary: 'Review leave policy copy in onboarding emails', creator: 'Ananya Iyer', dueDays: null, completed: false },
  { guid: 'lab-task-10', summary: 'Ship 0.0.2-beta.37 release notes', creator: 'Aarav Mehta', dueDays: -1, completed: true },
  { guid: 'lab-task-11', summary: 'Fix blurry tray icon on external displays', creator: 'Karan Shah', dueDays: null, completed: true },
];

export const OPEN_TASKS = TASKS.filter((t) => !t.completed);
export const taskById = (guid: string): Task => TASKS.find((t) => t.guid === guid) ?? TASKS[0]!;

const h = (hours: number, minutes = 0) => hours * 60 + minutes;

/** The day up to the current entry, which each scenario finishes differently. */
const HISTORY: Block[] = [
  { entry: 'e0', task: 'lab-task-08', kind: 'pending', start: h(9, 0), end: h(9, 30) },
  { entry: 'e1', task: 'lab-task-01', kind: 'work', start: h(9, 34), end: h(10, 14) },
  { entry: 'e2', task: 'lab-task-05', kind: 'work', start: h(10, 29), end: h(11, 24) },
  { entry: 'e3', task: 'lab-task-07', kind: 'manual', start: h(11, 32), end: h(12, 17) },
  { entry: 'e4', task: 'lab-task-02', kind: 'work', start: h(12, 27), end: h(13, 1) },
  { entry: 'e4', task: 'lab-task-02', kind: 'idle', start: h(13, 1), end: h(13, 9) },
  { entry: 'e4', task: 'lab-task-02', kind: 'work', start: h(13, 9), end: h(13, 37) },
  { entry: 'e5', task: 'lab-task-04', kind: 'meeting', start: h(13, 45), end: h(14, 15) },
  { entry: 'e6', task: 'lab-task-01', kind: 'work', start: h(14, 21), end: h(14, 58) },
  { entry: 'e6', task: 'lab-task-01', kind: 'idle', start: h(14, 58), end: h(15, 4) },
];

interface Track {
  mode: Mode;
  /** The entry the timer belongs to (running or paused); null when stopped. */
  entry: string | null;
  task: string;
  blocks: Block[];
  pausedAt: number | null;
}

function preset(mode: Mode): Track {
  if (mode === 'running') {
    return { mode, entry: 'e6', task: 'lab-task-01', pausedAt: null, blocks: [...HISTORY, { entry: 'e6', task: 'lab-task-01', kind: 'work', start: h(15, 4), end: null }] };
  }
  if (mode === 'paused') {
    return { mode, entry: 'e6', task: 'lab-task-01', pausedAt: h(15, 36), blocks: [...HISTORY, { entry: 'e6', task: 'lab-task-01', kind: 'work', start: h(15, 4), end: h(15, 36) }] };
  }
  return { mode, entry: null, task: 'lab-task-01', pausedAt: null, blocks: [...HISTORY, { entry: 'e6', task: 'lab-task-01', kind: 'work', start: h(15, 4), end: h(15, 26) }] };
}

const counts = (k: Kind) => k === 'work' || k === 'meeting' || k === 'manual';

export interface Day {
  now: number;
  mode: Mode;
  /** The task on the timer, or the one last tracked when stopped. */
  task: Task;
  blocks: Block[];
  /** Worked time on the current entry, idle trimmed out. */
  timerMs: number;
  /** When the current entry began (first block). */
  since: number | null;
  trackedMin: number;
  loggedTodayMin: (guid: string) => number;
  activityByHour: number[];
  start: (guid: string) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  reset: (mode: Mode) => void;
}

const DayContext = createContext<Day | null>(null);

export function useDay(): Day {
  const day = useContext(DayContext);
  if (!day) throw new Error('useDay outside DayProvider');
  return day;
}

export function DayProvider({ mode, children }: { mode: Mode; children: ReactNode }) {
  const loadedAt = useRef(Date.now());
  const [tick, setTick] = useState(() => Date.now());
  const [track, setTrack] = useState<Track>(() => preset(mode));

  useEffect(() => setTrack(preset(mode)), [mode]);
  useEffect(() => {
    const id = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const now = OPENED_AT + (tick - loadedAt.current) / 60_000;

  const day = useMemo<Day>(() => {
    const end = (b: Block) => b.end ?? now;
    const len = (b: Block) => Math.max(0, end(b) - b.start);
    const entryBlocks = track.entry ? track.blocks.filter((b) => b.entry === track.entry) : [];
    const timerMs = entryBlocks.filter((b) => b.kind !== 'idle').reduce((sum, b) => sum + len(b), 0) * 60_000;
    const trackedMin = track.blocks.filter((b) => counts(b.kind)).reduce((sum, b) => sum + len(b), 0);
    const loggedTodayMin = (guid: string) => track.blocks.filter((b) => b.task === guid && counts(b.kind)).reduce((sum, b) => sum + len(b), 0);

    // Share of each hour that was tracked, as a stand-in for activity.
    const activityByHour = Array.from({ length: 24 }, (_, hour) => {
      const from = hour * 60;
      const to = from + 60;
      const covered = track.blocks
        .filter((b) => b.kind === 'work' || b.kind === 'meeting')
        .reduce((sum, b) => sum + Math.max(0, Math.min(end(b), to) - Math.max(b.start, from)), 0);
      const wobble = 0.72 + ((hour * 37) % 23) / 100;
      return Math.min(1, (covered / 60) * wobble);
    });

    const close = (blocks: Block[], at: number) => blocks.map((b) => (b.end === null ? { ...b, end: at } : b));

    return {
      now,
      mode: track.mode,
      task: taskById(track.task),
      blocks: track.blocks,
      timerMs,
      since: entryBlocks[0]?.start ?? null,
      trackedMin,
      loggedTodayMin,
      activityByHour,
      start: (guid) =>
        setTrack((t) => {
          const entry = `e-${Math.round(now * 100)}`;
          return { mode: 'running', entry, task: guid, pausedAt: null, blocks: [...close(t.blocks, now), { entry, task: guid, kind: 'work', start: now, end: null }] };
        }),
      pause: () => setTrack((t) => (t.mode === 'running' ? { ...t, mode: 'paused', pausedAt: now, blocks: close(t.blocks, now) } : t)),
      resume: () =>
        setTrack((t) =>
          t.mode === 'paused' && t.entry
            ? { ...t, mode: 'running', pausedAt: null, blocks: [...t.blocks, { entry: t.entry, task: t.task, kind: 'work', start: now, end: null }] }
            : t,
        ),
      stop: () => setTrack((t) => ({ ...t, mode: 'idle', entry: null, pausedAt: null, blocks: close(t.blocks, now) })),
      reset: (m) => setTrack(preset(m)),
    };
  }, [track, now]);

  return <DayContext.Provider value={day}>{children}</DayContext.Provider>;
}

/* ---------- formatting ---------- */

export function fmtClock(ms: number): string {
  const t = Math.floor(ms / 1000);
  const hh = Math.floor(t / 3600);
  const mm = Math.floor((t % 3600) / 60);
  const ss = t % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${hh}:${pad(mm)}:${pad(ss)}`;
}

export function fmtDur(min: number): string {
  const total = Math.round(min);
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  if (hh === 0) return `${mm}m`;
  return `${hh}h ${String(mm).padStart(2, '0')}m`;
}

export function fmtTime(min: number, withPeriod = true): string {
  const total = Math.floor(min);
  const hh = Math.floor(total / 60) % 24;
  const mm = total % 60;
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  const time = mm === 0 && !withPeriod ? `${h12}` : `${h12}:${String(mm).padStart(2, '0')}`;
  return withPeriod ? `${time} ${hh < 12 ? 'AM' : 'PM'}` : time;
}

export function fmtHour(hour: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}${hour < 12 ? 'a' : 'p'}`;
}

export type DueTone = 'late' | 'soon' | 'later';

export function due(task: Task): { label: string; tone: DueTone } | null {
  if (task.dueDays === null) return null;
  if (task.dueDays < 0) return { label: `Overdue ${-task.dueDays}d`, tone: 'late' };
  if (task.dueDays === 0) return { label: 'Due today', tone: 'soon' };
  if (task.dueDays === 1) return { label: 'Tomorrow', tone: 'later' };
  const date = new Date();
  date.setDate(date.getDate() + task.dueDays);
  const label = task.dueDays < 7 ? date.toLocaleDateString('en-US', { weekday: 'long' }) : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return { label, tone: 'later' };
}

/** Open tasks in the order a person would reach for them: the current one, then by due date. */
export function sortedOpen(current: string): Task[] {
  const rank = (t: Task) => (t.guid === current ? -1000 : t.dueDays === null ? 999 : t.dueDays);
  return [...OPEN_TASKS].sort((a, b) => rank(a) - rank(b));
}

export function groupByDue(tasks: Task[]): { label: string; tasks: Task[] }[] {
  const groups: { label: string; test: (t: Task) => boolean }[] = [
    { label: 'Overdue', test: (t) => t.dueDays !== null && t.dueDays < 0 },
    { label: 'Today', test: (t) => t.dueDays === 0 },
    { label: 'This week', test: (t) => t.dueDays !== null && t.dueDays > 0 && t.dueDays < 7 },
    { label: 'Later', test: (t) => t.dueDays !== null && t.dueDays >= 7 },
    { label: 'No due date', test: (t) => t.dueDays === null },
  ];
  return groups.map((g) => ({ label: g.label, tasks: tasks.filter(g.test) })).filter((g) => g.tasks.length > 0);
}

export const STATS = { score: 78, keystrokes: 8412, clicks: 2906, screenshots: 96 };

export const KIND_LABEL: Record<Kind, string> = {
  work: 'Tracked',
  meeting: 'Meeting',
  manual: 'Manual',
  pending: 'Pending',
  idle: 'Idle',
};
