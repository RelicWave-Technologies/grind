import { dateKeyInTimeZone, localDayWindowInTimeZone } from '@grind/types';
import type {
  ScreenshotItem,
  TimerRecoveryNotice,
  TodayEntry,
  TodaySegment,
  UpdatePhase,
  UpdateStatus,
} from '../../src/renderer/lib/agent.d';
import type { CapabilityState, TimerPauseReason, TimerStatus, TrackingReadiness } from '../../src/shared/tracking';
import type { WorkspaceTimeContext } from '../../src/shared/workspaceTime';
import type { Scenario } from './scenario';

/**
 * The fake main process's state. One copy lives in every lab document (each
 * surface iframe and the gallery); they converge over a BroadcastChannel, see
 * store.ts. Everything that moves with the clock (worked time, task totals,
 * download progress) is DERIVED from timestamps on read, never accumulated, so
 * replicas agree without syncing every tick.
 */

export type AgentBridge = Window['agent'];
export type LarkStatus = Awaited<ReturnType<AgentBridge['lark']['status']>>;
export type LarkTask = Awaited<ReturnType<AgentBridge['lark']['tasks']>>['tasks'][number];
export type Insights = Awaited<ReturnType<AgentBridge['insights']['today']>>;
export type LarkMode = Scenario['lark'];

/** A world is split into slices so a change only fires the events it affects. */
export const SLICES = ['auth', 'timer', 'lark', 'tasks', 'shots', 'updates', 'perms', 'settings', 'notice'] as const;
export type Slice = (typeof SLICES)[number];

/** A Lark task as seeded: time logged before today is fixed, today's is derived from entries. */
export type SeedTask = Omit<LarkTask, 'loggedMs' | 'loggedTodayMs' | 'loggedTotalMs'> & { loggedBeforeTodayMs: number };

export interface World {
  /** Seed identity. A newer seed (reset / scenario change) replaces an older one everywhere. */
  id: string;
  seedAt: number;
  scenarioId: string;
  scenario: Scenario;
  /** Bumped on every commit; the higher rev wins between replicas of the same seed. */
  rev: number;
  revs: Record<Slice, number>;

  auth: 'loggedIn' | 'loggedOut';
  /** Today's entries, oldest first. The open one (if any) is `openEntryId`. */
  entries: TodayEntry[];
  openEntryId: string | null;
  entryRevision: number;
  pauseReason: TimerPauseReason | null;
  lastTaskGuid: string | null;

  larkMode: LarkMode;
  tasks: SeedTask[];
  notice: TimerRecoveryNotice | null;
  /** Newest first. */
  shots: ScreenshotItem[];
  perms: { screenRecording: CapabilityState; accessibility: CapabilityState };
  update: {
    phase: Exclude<UpdatePhase, 'available'>;
    currentVersion: string;
    availableVersion: string | null;
    manual: boolean;
    checkedAt: number | null;
    readyAt: number | null;
    /** While downloading, progress is a function of time since this instant. */
    downloadStartedAt: number | null;
  };
  floatingBarVisible: boolean;
}

// ── Workspace time ──────────────────────────────────────────────────────────

export const WORKSPACE_TIME_ZONE = 'Asia/Kolkata';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export interface DayWindow { date: string; start: number; end: number }

export function workspaceDay(now: number): DayWindow {
  const date = dateKeyInTimeZone(now, WORKSPACE_TIME_ZONE);
  const window = localDayWindowInTimeZone(date, WORKSPACE_TIME_ZONE);
  if (!window) throw new Error(`agent-lab: no day window for ${date}`);
  return { date, start: window.start.getTime(), end: window.end.getTime() };
}

export function workspaceTimeContext(world: World, now: number): WorkspaceTimeContext {
  if (world.scenario.wtime === 'syncing') {
    return { ready: false, timeZone: null, source: 'unavailable', date: null, dayStart: null, dayEnd: null };
  }
  const day = workspaceDay(now);
  return { ready: true, timeZone: WORKSPACE_TIME_ZONE, source: 'server', date: day.date, dayStart: day.start, dayEnd: day.end };
}

/** Mirrors the real timer: without a workspace day there is no "today" to total. */
function countingDay(world: World, now: number): DayWindow | null {
  return world.scenario.wtime === 'syncing' ? null : workspaceDay(now);
}

// ── Timer ───────────────────────────────────────────────────────────────────

export function openEntry(world: World): TodayEntry | null {
  return world.openEntryId ? world.entries.find((entry) => entry.id === world.openEntryId) ?? null : null;
}

export function openSegment(entry: TodayEntry): TodaySegment | null {
  const last = entry.segments[entry.segments.length - 1];
  return last && last.endedAt === null ? last : null;
}

const counts = (segment: TodaySegment) => segment.kind === 'WORK' || segment.kind === 'MEETING';

/** Union of worked intervals inside the day, like the real ledger projection. */
function workedMs(entries: TodayEntry[], day: DayWindow, now: number, filter?: (entry: TodayEntry) => boolean): number {
  const intervals: Array<[number, number]> = [];
  for (const entry of entries) {
    if (filter && !filter(entry)) continue;
    for (const segment of entry.segments) {
      if (!counts(segment)) continue;
      const start = Math.max(segment.startedAt, day.start);
      const end = Math.min(segment.endedAt ?? now, day.end, now);
      if (end > start) intervals.push([start, end]);
    }
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cursor = -Infinity;
  for (const [start, end] of intervals) {
    const from = Math.max(start, cursor);
    if (end > from) total += end - from;
    cursor = Math.max(cursor, end);
  }
  return total;
}

export function timerStatus(world: World, now: number): TimerStatus {
  const day = countingDay(world, now);
  const worked = day ? workedMs(world.entries, day, now) : 0;
  const entry = openEntry(world);
  if (!entry) return { state: 'IDLE', workedMs: worked };
  const segment = openSegment(entry);
  return {
    state: 'RUNNING',
    entryId: entry.id,
    revision: world.entryRevision,
    larkTaskGuid: entry.larkTaskGuid,
    startedAt: entry.segments[0]?.startedAt ?? now,
    segmentStartedAt: segment?.startedAt ?? null,
    workedMs: worked,
    paused: segment === null,
    pauseReason: segment === null ? world.pauseReason ?? 'MANUAL' : null,
  };
}

// ── Lark ────────────────────────────────────────────────────────────────────

export function larkStatus(world: World): LarkStatus {
  switch (world.larkMode) {
    case 'connected':
      return { configured: true, connected: true, reauthRequired: false, scopes: ['task:task:read', 'task:task:write', 'offline_access'] };
    case 'reauth':
      return { configured: true, connected: false, reauthRequired: true, scopes: ['task:task:read'], missingScopes: ['task:task:write'] };
    case 'offline':
      return { configured: true, connected: false, reauthRequired: false, scopes: [], offline: true };
    case 'unconfigured':
      return { configured: false, connected: false, reauthRequired: false, scopes: [] };
    default:
      return { configured: true, connected: false, reauthRequired: false, scopes: [] };
  }
}

export function taskView(world: World, now: number): LarkTask[] {
  const day = countingDay(world, now);
  return world.tasks.map(({ loggedBeforeTodayMs, ...task }) => {
    const today = day ? workedMs(world.entries, day, now, (entry) => entry.larkTaskGuid === task.guid) : 0;
    return { ...task, loggedMs: today, loggedTodayMs: today, loggedTotalMs: loggedBeforeTodayMs + today };
  });
}

export function larkTasks(world: World, now: number): Awaited<ReturnType<AgentBridge['lark']['tasks']>> {
  if (world.larkMode === 'connected') return { tasks: taskView(world, now), reauthRequired: false };
  if (world.larkMode === 'offline') return { tasks: taskView(world, now), reauthRequired: false, offline: true };
  if (world.larkMode === 'reauth') return { tasks: [], reauthRequired: true };
  return { tasks: [], reauthRequired: false };
}

// ── Permissions ─────────────────────────────────────────────────────────────

const isReady = (state: CapabilityState) => state === 'READY' || state === 'NOT_REQUIRED';

export function readiness(world: World, now: number): TrackingReadiness {
  const { screenRecording, accessibility } = world.perms;
  const blockingCapabilities: TrackingReadiness['blockingCapabilities'] = [];
  if (!isReady(screenRecording)) blockingCapabilities.push('SCREEN_RECORDING');
  if (!isReady(accessibility)) blockingCapabilities.push('ACCESSIBILITY');
  return {
    ready: blockingCapabilities.length === 0,
    checkedAt: new Date(now).toISOString(),
    screenRecording,
    accessibility,
    blockingCapabilities,
  };
}

// ── Updates ─────────────────────────────────────────────────────────────────

const DOWNLOAD_FROM_PERCENT = 42;
const DOWNLOAD_PERCENT_PER_SECOND = 2;

export function updateStatus(world: World, now: number): UpdateStatus {
  const u = world.update;
  let phase: UpdatePhase = u.phase;
  let percent: number | null = null;
  let readyAt = u.readyAt;
  if (u.phase === 'downloading' && u.downloadStartedAt !== null) {
    const elapsed = (now - u.downloadStartedAt) / 1000;
    percent = Math.min(100, DOWNLOAD_FROM_PERCENT + elapsed * DOWNLOAD_PERCENT_PER_SECOND);
    if (percent >= 100) {
      phase = 'ready';
      percent = null;
      readyAt = u.downloadStartedAt + ((100 - DOWNLOAD_FROM_PERCENT) / DOWNLOAD_PERCENT_PER_SECOND) * 1000;
    }
  }
  return {
    phase,
    enabled: true,
    currentVersion: u.currentVersion,
    channel: 'beta',
    availableVersion: u.availableVersion,
    percent,
    error: null,
    checkedAt: u.checkedAt,
    readyAt,
    manual: u.manual,
    // The real updater refuses to restart mid-session.
    canInstallNow: phase === 'ready' && world.openEntryId === null,
  };
}

// ── Insights ────────────────────────────────────────────────────────────────

/** Deterministic 0..1 noise so the chart looks the same in every frame. */
function noise(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

export function insights(world: World, now: number): Insights {
  const byHour = Array.from({ length: 24 }, () => 0);
  const day = countingDay(world, now);
  if (!day) {
    // Like src/main/ipc/insights.ts: no workspace timezone, no insights.
    return {
      day: '',
      score: { score: 0, trackedMinutes: 0, engagedMinutes: 0, protectedMinutes: 0, idleMinutes: 0 },
      totals: { keystrokes: 0, clicks: 0, mouseDistancePx: 0, scrollEvents: 0 },
      byHour,
    };
  }
  let idleMs = 0;
  for (const entry of world.entries) {
    for (const segment of entry.segments) {
      const start = Math.max(segment.startedAt, day.start);
      const end = Math.min(segment.endedAt ?? now, now);
      if (end <= start) continue;
      if (!counts(segment)) {
        idleMs += end - start;
        continue;
      }
      for (let t = start; t < end; t += MINUTE) {
        // Asia/Kolkata has no DST, so the hour is a plain offset from midnight.
        const hour = Math.min(23, Math.floor((t - day.start) / HOUR));
        const intensity = segment.kind === 'MEETING' ? 0.35 : 0.7 + 0.6 * noise(Math.floor(t / (10 * MINUTE)));
        byHour[hour] = (byHour[hour] ?? 0) + Math.round(48 * intensity);
      }
    }
  }
  const trackedMinutes = Math.round(workedMs(world.entries, day, now) / MINUTE);
  const events = byHour.reduce((sum, value) => sum + value, 0);
  return {
    day: day.date,
    score: {
      score: trackedMinutes > 0 ? 81 : 0,
      trackedMinutes,
      engagedMinutes: Math.round(trackedMinutes * 0.84),
      protectedMinutes: Math.round(trackedMinutes * 0.31),
      idleMinutes: Math.round(idleMs / MINUTE),
    },
    totals: {
      keystrokes: Math.round(events * 0.74),
      clicks: Math.round(events * 0.19),
      mouseDistancePx: Math.round(events * 41),
      scrollEvents: Math.round(events * 0.23),
    },
    byHour,
  };
}

export const TIME = { MINUTE, HOUR };
