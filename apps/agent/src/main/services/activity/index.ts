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
import { hasAccessibilityAccess } from '../permissions';
import { log } from '../../logger';

let store: ActivityStore | null = null;
let sealer: MinuteSealer | null = null;
const activeWindow = new ActiveWindowTracker();
let flushTimer: NodeJS.Timeout | null = null;
let started = false;
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
  activeWindow.observe(obs);
}

function getStore(): ActivityStore {
  if (store) return store;
  store = new ActivityStore(new Database(path.join(app.getPath('userData'), 'agent.db')));
  return store;
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
}

/** Whether the global input hook is actually running (Accessibility granted). */
export function isActivityCapturing(): boolean {
  return started;
}

/**
 * Start global input counting. Requires macOS Accessibility — uIOhook.start()
 * crashes without it, so we gate. Counts only (no key identity / content).
 */
export function startActivityCapture(): void {
  if (started) return;
  if (!hasAccessibilityAccess(false)) {
    log.warn('activity capture not started — Accessibility permission missing');
    return;
  }
  getStore();
  sealer = new MinuteSealer({ now: () => Date.now(), persist: persistSample });
  sealer.setRecording(recording, recordingEntryId); // seed current state

  uIOhook.on('keydown', () => sealer!.onKey(Date.now()));
  uIOhook.on('mousedown', () => sealer!.onClick());
  uIOhook.on('wheel', () => sealer!.onScroll());
  uIOhook.on('mousemove', (e) => sealer!.onMove(Date.now(), e.x, e.y));

  try {
    uIOhook.start();
    started = true;
    log.info('activity capture started');
  } catch (err) {
    log.warn('uIOhook.start failed', { err: String(err) });
    return;
  }

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
    activeApp: dom.activeApp,
    activeAppBundle: dom.activeAppBundle,
    activeTitle: dom.activeTitle,
    activeUrl: dom.activeUrl,
    synced: 0,
  });
  void flushActivity(getStore());
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
  if (started) {
    try {
      uIOhook.stop();
    } catch {
      /* ignore */
    }
    started = false;
  }
}

/** Today's input totals (for an in-app summary). */
export function todayActivity(): { keystrokes: number; clicks: number; scrollEvents: number } {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return getStore().countSince(d.getTime());
}

export { getStore as getActivityStore };
