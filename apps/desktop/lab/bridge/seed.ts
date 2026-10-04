import pkg from '../../package.json';
import type { ScreenshotItem, TodayEntry, TodaySegment } from '../../src/lib/agent.d';
import type { CapabilityState } from '../../src/shared/tracking';
import { scenarioId, type Scenario } from './scenario';
import { SLICES, TIME, workspaceDay, type SeedTask, type Slice, type World } from './world';

const { MINUTE, HOUR } = TIME;
const DAY = 24 * HOUR;

export const LAB_VERSION = pkg.version;
export const LAB_NEXT_VERSION = '0.0.2-beta.38';
export const RUNNING_TASK_GUID = 'lab-task-01';

export const ME = { id: 'lab-user-aarav', name: 'Aarav Mehta', email: 'aarav.mehta@relicwave.test' };

/**
 * Nine open tasks (one more than the Today list shows before it collapses) and
 * two completed ones. Due dates are relative to the workspace day so the chips
 * read "Overdue", "Due today", "Due tomorrow", "Due in 4d" whatever the date.
 */
function seedTasks(now: number, dayStart: number): SeedTask[] {
  const dueIn = (days: number) => dayStart + days * DAY + 17 * HOUR;
  const ago = (ms: number) => now - ms;
  const task = (
    n: number,
    summary: string,
    creatorName: string | null,
    createdAt: number,
    due: number | null,
    loggedBeforeTodayMs: number,
    completed = false,
  ): SeedTask => {
    const guid = `lab-task-${String(n).padStart(2, '0')}`;
    return {
      guid,
      summary,
      completed,
      url: `https://applink.larksuite.com/client/todo/detail?guid=${guid}`,
      due,
      createdAt,
      creatorId: creatorName ? `lab-user-${creatorName.split(' ')[0]!.toLowerCase()}` : null,
      creatorName,
      loggedBeforeTodayMs,
    };
  };
  return [
    task(1, 'Floating bar: hover and pause states for the new timer pill', 'Priya Nair', ago(3 * DAY), dueIn(0), 2 * HOUR + 10 * MINUTE),
    task(2, 'Q3 client onboarding deck — review pricing slide with Rahul', 'Rahul Mehta', ago(6 * DAY), dueIn(1), 3 * HOUR + 25 * MINUTE),
    task(
      3,
      'Investigate why screenshot uploads stall after the laptop wakes from sleep on flaky hotel Wi-Fi, then add a bounded retry with backoff and a visible failed state in Reports so people can tell what happened to their evidence',
      'Aarav Mehta',
      ago(9 * DAY),
      dueIn(-2),
      5 * HOUR + 40 * MINUTE,
    ),
    task(4, 'Weekly sync notes → Lark doc', 'Ananya Iyer', ago(2 * DAY), null, 45 * MINUTE),
    task(5, 'Design QA: People page on the dashboard', 'Priya Nair', ago(4 * DAY), dueIn(4), 1 * HOUR + 5 * MINUTE),
    task(6, 'Write the API reference for time entries (v1)', 'Karan Shah', ago(12 * DAY), dueIn(12), 0),
    task(7, 'Customer call prep — RelicWave Technologies', 'Rahul Mehta', ago(3 * HOUR), dueIn(0), 0),
    task(8, 'Tune idle detection thresholds for meetings', null, ago(20 * DAY), null, 7 * HOUR + 15 * MINUTE),
    task(9, 'Review leave policy copy in onboarding emails', 'Ananya Iyer', ago(1 * DAY), null, 20 * MINUTE),
    task(10, 'Ship 0.0.2-beta.37 release notes', 'Aarav Mehta', ago(5 * DAY), dueIn(-1), 1 * HOUR + 50 * MINUTE, true),
    task(11, 'Fix blurry tray icon on external displays', 'Karan Shah', ago(15 * DAY), null, 2 * HOUR + 30 * MINUTE, true),
  ];
}

type Part = [TodaySegment['kind'], number];
interface Block { task: string; source: 'AUTO' | 'MANUAL'; parts: Part[]; gapBefore: number }

/** Older blocks, newest first, each with the idle gap (minutes) before it. */
const OLDER_BLOCKS: Block[] = [
  { task: 'lab-task-03', source: 'AUTO', parts: [['WORK', 50]], gapBefore: 5 },
  { task: 'lab-task-04', source: 'AUTO', parts: [['MEETING', 30]], gapBefore: 40 },
  { task: 'lab-task-02', source: 'AUTO', parts: [['WORK', 34], ['IDLE_TRIMMED', 8], ['WORK', 28]], gapBefore: 10 },
  { task: 'lab-task-07', source: 'MANUAL', parts: [['WORK', 45]], gapBefore: 8 },
  { task: 'lab-task-05', source: 'AUTO', parts: [['WORK', 55]], gapBefore: 15 },
  { task: 'lab-task-01', source: 'AUTO', parts: [['WORK', 40]], gapBefore: 0 },
];

/** Drops what falls before `lower` and trims the first survivor to it. */
function clip(segments: TodaySegment[], lower: number): TodaySegment[] {
  return segments
    .filter((segment) => (segment.endedAt ?? Infinity) > lower)
    .map((segment) => (segment.startedAt < lower ? { ...segment, startedAt: lower } : segment));
}

interface Timeline { entries: TodayEntry[]; openEntryId: string | null }

/**
 * Lays the day out BACKWARDS from now, so it is plausible at any hour: from
 * 09:30 workspace time on a normal afternoon, squeezed into the hours since
 * midnight if the lab is opened in the small hours.
 */
function seedTimeline(scenario: Scenario, now: number, dayStart: number): Timeline {
  const m = (minutes: number) => minutes * MINUTE;
  // Never later than 15 minutes ago, so a just-started session survives the clip.
  const lower = Math.min(now >= dayStart + 11 * HOUR ? dayStart + 9.5 * HOUR : dayStart + 10 * MINUTE, now - 15 * MINUTE);
  const current = (segments: TodaySegment[]): TodayEntry => ({
    id: 'lab-entry-current',
    source: 'AUTO',
    larkTaskGuid: RUNNING_TASK_GUID,
    segments: clip(segments, lower),
  });

  if (scenario.day === 'empty') {
    if (scenario.timer === 'running') {
      return { entries: [current([{ kind: 'WORK', startedAt: now - m(2), endedAt: null }])], openEntryId: 'lab-entry-current' };
    }
    if (scenario.timer === 'paused') {
      return { entries: [current([{ kind: 'WORK', startedAt: now - m(11), endedAt: now - m(1) }])], openEntryId: 'lab-entry-current' };
    }
    return { entries: [], openEntryId: null };
  }

  // The current (or most recent) entry: work, an idle trim, then work again.
  const lastEnd = scenario.timer === 'running' ? null : scenario.timer === 'paused' ? now - m(4) : now - m(16);
  const head = current([
    { kind: 'WORK', startedAt: now - m(87), endedAt: now - m(44) },
    { kind: 'IDLE_TRIMMED', startedAt: now - m(44), endedAt: now - m(38) },
    { kind: 'WORK', startedAt: now - m(38), endedAt: lastEnd },
  ]);

  const older: TodayEntry[] = [];
  let cursor = now - m(87) - m(12);
  for (const [index, block] of OLDER_BLOCKS.entries()) {
    if (cursor <= lower) break;
    const total = block.parts.reduce((sum, [, minutes]) => sum + minutes, 0);
    let t = cursor - m(total);
    const segments: TodaySegment[] = block.parts.map(([kind, minutes]) => {
      const segment = { kind, startedAt: t, endedAt: t + m(minutes) };
      t += m(minutes);
      return segment;
    });
    const kept = clip(segments, lower);
    if (kept.length > 0) {
      older.push({ id: `lab-entry-${index + 1}`, source: block.source, larkTaskGuid: block.task, segments: kept });
    }
    cursor -= m(total + block.gapBefore);
  }

  const entries = [...older.reverse(), ...(head.segments.length > 0 ? [head] : [])];
  const open = scenario.timer !== 'idle' && head.segments.length > 0;
  return { entries, openEntryId: open ? head.id : null };
}

/** A capture every ten minutes of tracked (AUTO) time, newest first, capped at 14. */
function seedShots(scenario: Scenario, entries: TodayEntry[], now: number): ScreenshotItem[] {
  const times: number[] = [];
  for (const entry of entries) {
    if (entry.source !== 'AUTO') continue;
    for (const segment of entry.segments) {
      if (segment.kind === 'IDLE_TRIMMED') continue;
      const end = segment.endedAt ?? now;
      for (let t = segment.startedAt + 3 * MINUTE; t < end; t += 10 * MINUTE) times.push(t);
    }
  }
  times.sort((a, b) => b - a);
  return times.slice(0, 14).map((capturedAt, index) => {
    const wobble = (n: number) => Math.round(18 + ((capturedAt / 1000 / 60 * n) % 64));
    let uploadState = 'uploaded';
    let attempts = 1;
    let lastError: string | null = null;
    if (scenario.shots === 'uploading' && index < 3) uploadState = index === 0 ? 'uploading' : 'pending';
    if (scenario.shots === 'failed' && index < 3) {
      uploadState = 'failed';
      attempts = 5;
      lastError = 'Upload failed: request to storage timed out after 30s';
    }
    return { id: `lab-shot-${capturedAt}`, capturedAt, uploadState, keyboardPct: wobble(7), mousePct: wobble(3), attempts, lastError };
  });
}

function seedPerms(scenario: Scenario): World['perms'] {
  const pick: Record<Scenario['perms'], [CapabilityState, CapabilityState]> = {
    ready: ['READY', 'READY'],
    grant: ['NEEDS_GRANT', 'NEEDS_GRANT'],
    restart: ['NEEDS_RESTART', 'READY'],
  };
  const [screenRecording, accessibility] = pick[scenario.perms];
  return { screenRecording, accessibility };
}

function seedUpdate(scenario: Scenario, now: number): World['update'] {
  const base = { currentVersion: LAB_VERSION, manual: false, checkedAt: now - 20 * MINUTE, downloadStartedAt: null, readyAt: null };
  if (scenario.update === 'downloading') {
    return { ...base, phase: 'downloading', availableVersion: LAB_NEXT_VERSION, downloadStartedAt: now };
  }
  if (scenario.update === 'ready') {
    return { ...base, phase: 'ready', availableVersion: LAB_NEXT_VERSION, readyAt: now - 6 * MINUTE };
  }
  return { ...base, phase: 'not-available', availableVersion: null };
}

export function seedWorld(scenario: Scenario, now: number): World {
  const day = workspaceDay(now);
  const { entries, openEntryId } = seedTimeline(scenario, now, day.start);
  const recovered = [...entries].reverse().find((entry) => entry.id !== openEntryId && entry.source === 'AUTO');
  const recoveredAt = recovered?.segments[recovered.segments.length - 1]?.endedAt ?? now - 3 * HOUR;
  const revs = Object.fromEntries(SLICES.map((slice) => [slice, 0])) as Record<Slice, number>;

  return {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    seedAt: now,
    scenarioId: scenarioId(scenario),
    scenario,
    rev: 0,
    revs,
    auth: scenario.auth === 'in' ? 'loggedIn' : 'loggedOut',
    entries,
    openEntryId,
    entryRevision: 3,
    pauseReason: scenario.timer === 'paused' ? 'MANUAL' : null,
    lastTaskGuid: RUNNING_TASK_GUID,
    larkMode: scenario.lark,
    tasks: seedTasks(now, day.start),
    notice: scenario.notice === 'off'
      ? null
      : {
          entryId: recovered?.id ?? 'lab-entry-yesterday',
          recoveredAt,
          reason: scenario.notice === 'sleep' ? 'sleep_stop' : 'unexpected_shutdown',
          observedAt: recoveredAt + 18 * MINUTE,
        },
    shots: seedShots(scenario, entries, now),
    perms: seedPerms(scenario),
    update: seedUpdate(scenario, now),
    floatingBarVisible: true,
  };
}
