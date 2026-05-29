import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'node:path';
import { ulid } from 'ulid';
import { uIOhook } from 'uiohook-napi';
import { ActivityAggregator } from './aggregator';
import { ActivityStore } from './store';
import { flushActivity } from './sync';
import { getTimerService } from '../timer';
import { hasAccessibilityAccess } from '../permissions';
import { log } from '../../logger';

let store: ActivityStore | null = null;
let agg: ActivityAggregator | null = null;
let flushTimer: NodeJS.Timeout | null = null;
let started = false;
let recording = false; // mirror of "timer running & not paused"
let bucketStart = 0;

function getStore(): ActivityStore {
  if (store) return store;
  store = new ActivityStore(new Database(path.join(app.getPath('userData'), 'agent.db')));
  return store;
}

/** Update the recording flag cheaply (called on a 1s tick from main). */
export function setActivityRecording(on: boolean): void {
  recording = on;
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
  agg = new ActivityAggregator();
  getStore();
  bucketStart = Math.floor(Date.now() / 60000) * 60000;

  uIOhook.on('keydown', () => { if (recording) agg!.onKey(Date.now()); });
  uIOhook.on('mousedown', () => { if (recording) agg!.onClick(); });
  uIOhook.on('wheel', () => { if (recording) agg!.onScroll(); });
  uIOhook.on('mousemove', (e) => { if (recording) agg!.onMove(Date.now(), e.x, e.y); });

  try {
    uIOhook.start();
    started = true;
    log.info('activity capture started');
  } catch (err) {
    log.warn('uIOhook.start failed', { err: String(err) });
    return;
  }

  // Flush one sample per minute.
  flushTimer = setInterval(() => flushMinute(), 60_000);
}

function flushMinute(): void {
  if (!agg) return;
  const empty = agg.isEmpty();
  const sample = agg.flush(bucketStart);
  bucketStart = Math.floor(Date.now() / 60000) * 60000;

  // Only persist real activity captured while tracking.
  if (empty) return;
  const status = getTimerService().status();
  if (status.state !== 'RUNNING' || status.paused) return;

  getStore().insert({
    id: ulid(),
    timeEntryId: status.entryId,
    bucketStart: sample.bucketStart,
    keystrokes: sample.keystrokes,
    clicks: sample.clicks,
    mouseDistancePx: sample.mouseDistancePx,
    scrollEvents: sample.scrollEvents,
    ikiCv: sample.ikiCv,
    moveSpeedCv: sample.moveSpeedCv,
    pathStraightness: sample.pathStraightness,
    synced: 0,
  });

  void flushActivity(getStore());
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
