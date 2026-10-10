import { ulid } from 'ulid';
import { uIOhook } from 'uiohook-napi';
import { MinuteSealer, minuteFloor, type SealOwner } from './minuteSealer';
import type { ActivitySample } from './aggregator';
import { ActiveWindowTracker, type ActiveWindowObservation } from './activeWindow';
import { ActivityStore, type ActivityOwner } from './store';
import { flushActivity } from './sync';
import { ActivitySyncDrain, type ActivitySyncDrainReason, type ActivitySyncDrainResult } from './syncDrain';
import { hasAccessibilityAccess } from '../permissions';
import { getCapturePolicy } from '../agentConfig';
import { openAgentDb } from '../agentDb';
import { serverAlignedNow } from '../serverClock';
import { log } from '../../logger';
import { getWorkspaceTimeContext } from '../workspaceTime';
import type { PolicyFlags } from '@grind/types';
import { drainTimerSyncNow, getTimerService } from '../timer';
import { currentOwner, oncePerOwner, sameOwner } from '../capture/owner';
import { loadTokens } from '../tokenStore';

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
// A failed hook start is retried on a backoff, not on every 1s recording tick:
// on Windows a hook that will not start was retried and logged every second
// for as long as the timer ran. Device clock: only ever compared with itself.
const HOOK_RETRY_MIN_MS = 2_000;
const HOOK_RETRY_MAX_MS = 5 * 60_000;
let hookRetryDelayMs = 0;
let nextHookRetryAt = 0;
let lastLoggedHookError: string | null = null;
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
/** The account signed in when recording last started — a minute belongs to it. */
let recordingOwner: SealOwner | null = null;

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
  store = new ActivityStore(openAgentDb());
  return store;
}

/** Claim pre-owner-scoping samples for an account — once per owner change, not per flush or query. */
export const claimUnownedActivity: (owner: ActivityOwner) => void = oncePerOwner((owner) => {
  getStore().claimUnowned(owner);
});

const activitySyncDrain = new ActivitySyncDrain({
  getStore,
  beforeFlush: () => drainTimerSyncNow('manual'),
  flush: (activityStore) => {
    const owner = currentOwner();
    return flushActivity(activityStore, {
      owner,
      isTimeEntryPendingCreate: (entryId) => getTimerService().isPendingCreate(entryId),
      claimUnowned: claimUnownedActivity,
      stillOwner: async () =>
        sameOwner(owner, currentOwner()) && sameOwner(owner, await loadTokens().catch(() => null)),
    });
  },
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
  // Stamp the account now, while it is recording — at seal time a sign-out or
  // account switch may already have happened.
  if (on) recordingOwner = currentOwner();
  sealer?.setRecording(on, entryId, recordingOwner);
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
    // eslint-disable-next-line no-restricted-syntax -- device<->device: compared with nextHookRetryAt from this same clock
    if (lastHookError === null || Date.now() >= nextHookRetryAt) startHook();
  } else if (!recording && hookRunning) {
    stopHook();
    lastHookError = null;
  }
  emitCaptureStatus();
}

function stopHook(): void {
  try {
    uIOhook.stop();
  } catch {
    /* ignore */
  }
  hookRunning = false;
}

function resetHookBackoff(): void {
  hookRetryDelayMs = 0;
  nextHookRetryAt = 0;
  lastLoggedHookError = null;
}

/** One attempt at the native hook. A failure is stored, logged only when it
 *  changes, and pushes the next automatic attempt back exponentially. */
function startHook(): boolean {
  try {
    uIOhook.start();
    hookRunning = true;
    if (lastHookError !== null) log.info('uIOhook started after an earlier failure');
    lastHookError = null;
    resetHookBackoff();
    return true;
  } catch (err) {
    hookRunning = false;
    lastHookError = String(err);
    hookRetryDelayMs = hookRetryDelayMs === 0
      ? HOOK_RETRY_MIN_MS
      : Math.min(hookRetryDelayMs * 2, HOOK_RETRY_MAX_MS);
    // eslint-disable-next-line no-restricted-syntax -- device<->device: only compared with Date.now() in syncHook
    nextHookRetryAt = Date.now() + hookRetryDelayMs;
    if (lastHookError !== lastLoggedHookError) {
      lastLoggedHookError = lastHookError;
      log.warn('uIOhook.start failed', { err: lastHookError, nextRetryMs: hookRetryDelayMs });
    }
    return false;
  }
}

/**
 * An explicit "check again" for a stored hook failure: forget it and try the
 * hook once now, ignoring the backoff. Without this a single failed start
 * blocked tracking until quit — the hook is only started while recording, and
 * recording cannot resume while the failure stands. When not recording the
 * hook is stopped again straight away; the attempt only proves it can start.
 */
export function retryActivityHook(): ActivityCaptureStatus {
  if (!started || hookRunning || lastHookError === null || !hasAccessibilityAccess(false)) {
    return getActivityCaptureStatus();
  }
  lastHookError = null;
  if (startHook() && !recording) stopHook();
  emitCaptureStatus();
  return getActivityCaptureStatus();
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
  // bucketStart is the key the server upserts on and filters by window, so it
  // has to share a clock with the entries it is evidence for.
  sealer = new MinuteSealer({
    now: () => serverAlignedNow(),
    persist: persistSample,
    // A tracked minute only counts as a quiet minute if we were listening.
    isCapturing: () => hookRunning,
  });
  sealer.setRecording(recording, recordingEntryId, recordingOwner); // seed current state

  uIOhook.on('keydown', () => {
    emitTrackedInputActivity();
    sealer!.onKey(serverAlignedNow());
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
    const t = serverAlignedNow();
    if (t - lastMoveTs < MOVE_THROTTLE_MS) return;
    lastMoveTs = t;
    emitTrackedInputActivity();
    sealer!.onMove(t, e.x, e.y);
  });

  // Capture system is initialized; the hook itself starts only while recording.
  started = true;
  syncHook();
  log.info('activity capture ready', { recording });

  // Seal one bucket per minute, just after each wall-clock boundary. Every
  // tracked minute is stored — a quiet one as zeros — and a minute sealed
  // twice adds up rather than overwriting (see MinuteSealer).
  scheduleMinuteSeal();
}

/** Fire just after the next minute boundary — a plain 60s interval drifts against the clock. */
function scheduleMinuteSeal(): void {
  if (flushTimer) clearTimeout(flushTimer);
  const now = serverAlignedNow();
  const delay = minuteFloor(now) + 60_000 - now + 250;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try {
      if (sealer && sealer.tick() == null) {
        // Nothing to seal — still bound the window tracker so it can't drift
        // during long untracked stretches.
        activeWindow.prune(minuteFloor(serverAlignedNow()));
      }
    } catch (err) {
      // A failed seal (a locked or full database) must not stop every later
      // minute from sealing.
      log.error('activity minute seal failed', { err: String(err) });
    } finally {
      if (started) scheduleMinuteSeal();
    }
  }, delay);
}

/**
 * Durably write a sealed minute to the local queue — added to the minute
 * already stored, if any — and kick a best-effort sync.
 */
function persistSample(sample: ActivitySample, entryId: string | null, owner: SealOwner | null): void {
  const dom = activeWindow.dominantFor(sample.bucketStart, sample.bucketStart + 60_000);
  const policy = getCapturePolicy();
  activeWindow.prune(sample.bucketStart + 60_000);
  const written = getStore().persistMinute({
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
    ownerUserId: owner?.userId ?? null,
    ownerWorkspaceId: owner?.workspaceId ?? null,
  });
  if (written) void drainActivityNow('sample');
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
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (hookRunning) stopHook();
  started = false;
  lastHookError = null;
  resetHookBackoff();
  emitCaptureStatus();
}

/** Today's input totals (for an in-app summary). */
export function todayActivity(): { keystrokes: number; clicks: number; scrollEvents: number } {
  const context = getWorkspaceTimeContext();
  const owner = currentOwner();
  return context.ready && context.dayStart !== null && owner
    ? getStore().countSince(context.dayStart, owner)
    : { keystrokes: 0, clicks: 0, scrollEvents: 0 };
}

export { getStore as getActivityStore };
