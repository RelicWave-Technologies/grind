import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'node:path';
import { ulid } from 'ulid';
import { uIOhook } from 'uiohook-napi';
import { MinuteSealer } from './minuteSealer';
import type { ActivitySample } from './aggregator';
import { ActiveWindowTracker, type ActiveWindowObservation } from './activeWindow';
import { ActivityStore } from './store';
import { flushActivity } from './sync';
import { ActivitySyncDrain, type ActivitySyncDrainReason, type ActivitySyncDrainResult } from './syncDrain';
import { hasAccessibilityAccess } from '../permissions';
import { getCapturePolicy } from '../agentConfig';
import { log } from '../../logger';
import { getWorkspaceTimeContext } from '../workspaceTime';
import type { PolicyFlags } from '@grind/types';
import { drainTimerSyncNow, getTimerService } from '../timer';

let store: ActivityStore | null = null;
let sealer: MinuteSealer | null = null;
const activeWindow = new ActiveWindowTracker();
let flushTimer: NodeJS.Timeout | null = null;
let started = false;
// The global input hook is only RUN while actually recording — leaving it on
// idle delivers every system mousemove (100s/sec) across the native→V8 boundary
// for no benefit (events no-op unless recording), which heats the CPU.
let hookRunning = false;
let lastHookError: string | null = null;
const captureStatusListeners = new Set<(status: ActivityCaptureStatus) => void>();
const trackedInputListeners = new Set<() => void>();
// Throttle mousemove processing: the OS fires it at the pointer's full poll rate
// (often 125Hz+); sampling at ~20Hz is ample for distance / speed-CV metrics.
let lastMoveTs = 0;
const MOVE_THROTTLE_MS = 50;
// Mirrors of "timer running & not paused" + the active entry, kept so a sealer
// created after the first recording tick can be seeded with current state.
let recording = false;
let recordingEntryId: string | null = null;

/**
 * Called by the meeting/window poller (~every 10s) with the foreground
 * window. Safe to call BEFORE startActivityCapture — the tracker is
 * always live so we capture context even outside the keystroke window.
 */
export function recordActiveWindow(obs: ActiveWindowObservation): void {
  const policy = getCapturePolicy();
  if (!policy.captureApps) return;
  activeWindow.observe({
    ...obs,
    title: policy.captureTitles ? obs.title : null,
    url: policy.captureUrls ? obs.url : null,
  });
}

function getStore(): ActivityStore {
  if (store) return store;
  store = new ActivityStore(new Database(path.join(app.getPath('userData'), 'agent.db')));
  return store;
}

const activitySyncDrain = new ActivitySyncDrain({
  getStore,
  beforeFlush: () => drainTimerSyncNow('manual'),
  flush: (activityStore) => flushActivity(activityStore, (entryId) => getTimerService().isPendingCreate(entryId)),
  logger: log,
});

export function startActivitySyncDrain(): void {
  activitySyncDrain.start();
}

export function drainActivityNow(reason: ActivitySyncDrainReason): Promise<ActivitySyncDrainResult> {
  return activitySyncDrain.drainNow(reason);
}

/**
 * Update the recording flag cheaply (called on a 1s tick from main). `entryId`
 * is the active time-entry so a sealed minute is credited to it even if the
 * timer has since stopped (entryId goes null after a stop).
 */
export function setActivityRecording(on: boolean, entryId: string | null = null): void {
  recording = on;
  if (on && entryId) recordingEntryId = entryId;
  sealer?.setRecording(on, entryId);
  syncHook();
}

export function applyActivityCapturePolicy(policy: PolicyFlags): void {
  if (!policy.captureApps || !policy.captureTitles || !policy.captureUrls) {
    activeWindow.clear();
    const rows = getStore().scrubActiveFields(policy);
    if (rows > 0) {
      log.info('local activity active-window fields scrubbed for capture policy', { rows, policy });
    }
  }
}

/**
 * Start the global input hook only while recording; stop it otherwise. Idempotent
 * and cheap to call on the 1s recording tick. This is the main heat fix: no input
 * events are delivered to JS when the user isn't actively tracking.
 */
function syncHook(): void {
  if (!started) {
    emitCaptureStatus();
    return;
  }
  if (recording && !hookRunning) {
    try {
      uIOhook.start();
      hookRunning = true;
      lastHookError = null;
    } catch (err) {
      hookRunning = false;
      lastHookError = String(err);
      log.warn('uIOhook.start failed', { err: String(err) });
    }
  } else if (!recording && hookRunning) {
    try {
      uIOhook.stop();
    } catch {
      /* ignore */
    }
    hookRunning = false;
    lastHookError = null;
  }
  emitCaptureStatus();
}

/** Whether the global input hook is actually running (Accessibility granted). */
export function isActivityCapturing(): boolean {
  return hookRunning;
}

export interface ActivityCaptureStatus {
  trusted: boolean;
  ready: boolean;
  recording: boolean;
  capturing: boolean;
  hookRunning: boolean;
  lastHookError: string | null;
}

export function onActivityCaptureStatusChange(listener: (status: ActivityCaptureStatus) => void): () => void {
  captureStatusListeners.add(listener);
  return () => captureStatusListeners.delete(listener);
}

export function onTrackedInputActivity(listener: () => void): () => void {
  trackedInputListeners.add(listener);
  return () => trackedInputListeners.delete(listener);
}

function emitCaptureStatus(): void {
  const status = getActivityCaptureStatus();
  for (const listener of captureStatusListeners) listener(status);
}

function emitTrackedInputActivity(): void {
  if (!recording) return;
  for (const listener of trackedInputListeners) listener();
}

export function getActivityCaptureStatus(): ActivityCaptureStatus {
  const trusted = hasAccessibilityAccess(false);
  return {
    trusted,
    ready: started,
    recording,
    capturing: hookRunning,
    hookRunning,
    lastHookError,
  };
}

/**
 * Start global input counting. Requires macOS Accessibility — uIOhook.start()
 * crashes without it, so we gate. Counts only (no key identity / content).
 */
export function startActivityCapture(): void {
  if (started) return;
  if (!hasAccessibilityAccess(false)) {
    lastHookError = null;
    log.warn('activity capture not started — Accessibility permission missing');
    emitCaptureStatus();
    return;
  }
  getStore();
  sealer = new MinuteSealer({ now: () => Date.now(), persist: persistSample });
  sealer.setRecording(recording, recordingEntryId); // seed current state

  uIOhook.on('keydown', () => {
    emitTrackedInputActivity();
    sealer!.onKey(Date.now());
  });
  uIOhook.on('mousedown', () => {
    emitTrackedInputActivity();
    sealer!.onClick();
  });
  uIOhook.on('wheel', () => {
    emitTrackedInputActivity();
    sealer!.onScroll();
  });
  uIOhook.on('mousemove', (e) => {
    const t = Date.now();
    if (t - lastMoveTs < MOVE_THROTTLE_MS) return;
    lastMoveTs = t;
    emitTrackedInputActivity();
    sealer!.onMove(t, e.x, e.y);
  });

  // Capture system is initialized; the hook itself starts only while recording.
  started = true;
  syncHook();
  log.info('activity capture ready', { recording });

  // Seal one bucket per minute. The sealer guarantees a non-empty minute is
  // always persisted (events are recording-gated at the source, so they're
  // legitimate work) and never double-emits a bucket.
  flushTimer = setInterval(() => {
    if (sealer!.tick() == null) {
      // Empty/duplicate minute — still bound the window tracker so it can't
      // drift even during long idle stretches.
      activeWindow.prune(Math.floor(Date.now() / 60_000) * 60_000);
    }
  }, 60_000);
}

/**
 * Durably write a sealed minute to the local queue and kick a best-effort sync.
 * Called by the sealer at most once per bucket (see {@link MinuteSealer}).
 */
function persistSample(sample: ActivitySample, entryId: string | null): void {
  const dom = activeWindow.dominantFor(sample.bucketStart, sample.bucketStart + 60_000);
  const policy = getCapturePolicy();
  activeWindow.prune(sample.bucketStart + 60_000);
  getStore().insert({
    id: ulid(),
    timeEntryId: entryId,
    bucketStart: sample.bucketStart,
    keystrokes: sample.keystrokes,
    clicks: sample.clicks,
    mouseDistancePx: sample.mouseDistancePx,
    scrollEvents: sample.scrollEvents,
    ikiCv: sample.ikiCv,
    moveSpeedCv: sample.moveSpeedCv,
    pathStraightness: sample.pathStraightness,
    activeApp: policy.captureApps ? dom.activeApp : null,
    activeAppBundle: policy.captureApps ? dom.activeAppBundle : null,
    activeTitle: policy.captureApps && policy.captureTitles ? dom.activeTitle : null,
    activeUrl: policy.captureApps && policy.captureUrls ? dom.activeUrl : null,
    synced: 0,
  });
  void drainActivityNow('sample');
}

/**
 * Seal the in-flight (partial) minute to the local queue — call on app quit so
 * the last sub-minute of work isn't lost. Synchronous + durable (better-sqlite3
 * insert); the server drains it on the next launch's first flush.
 */
export function flushPartialActivity(): void {
  sealer?.sealPartial();
}

export function stopActivityCapture(): void {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = null;
  if (hookRunning) {
    try {
      uIOhook.stop();
    } catch {
      /* ignore */
    }
    hookRunning = false;
  }
  started = false;
  lastHookError = null;
  emitCaptureStatus();
}

/** Today's input totals (for an in-app summary). */
export function todayActivity(): { keystrokes: number; clicks: number; scrollEvents: number } {
  const context = getWorkspaceTimeContext();
  return context.ready && context.dayStart !== null
    ? getStore().countSince(context.dayStart)
    : { keystrokes: 0, clicks: 0, scrollEvents: 0 };
}

export { getStore as getActivityStore };
