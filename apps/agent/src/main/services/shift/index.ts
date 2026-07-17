import { powerMonitor } from 'electron';
import type { MyShiftResponse, ShiftDto } from '@grind/types';
import { api } from '../apiClient';
import { log } from '../../logger';
import {
  tickShiftMonitor,
  ackToday,
  snooze,
  expire,
  INITIAL_STATE,
  type ShiftMonitorState,
  resolveShiftWindow,
} from './decide';
import { showReadyToWork, hideReadyToWork, isReadyToWorkVisible } from '../../readyToWork';
import { getWorkspaceTimeZone } from '../workspaceTime';
import type { TodayShiftWindow } from '../../../shared/shift';

/**
 * ShiftMonitor — owns the "Ready to work?" toast lifecycle.
 *
 * Strategy:
 *  - On boot + after every powerMonitor resume, refresh /v1/auth/me/shift.
 *  - Poll the reducer every 30 s. The reducer returns:
 *      show     → render the toast (top-right, non-stealing focus)
 *      hide     → buffer expired; close the toast, run `expire()`
 *      schedule → outside the window; set a one-shot timer for the next
 *                 start so we stop spinning the 30 s interval
 *      noop     → silence
 *  - `onUserDecision('yes' | 'not_yet')` is called by the renderer via
 *    IPC; we apply ackToday / snooze respectively and the next tick
 *    quiets the toast.
 *
 * The state lives in memory — fresh on each agent boot is fine. A user
 * who killed the agent mid-buffer will get the toast again on relaunch
 * which is the desired behaviour (no acknowledgement → keep nudging).
 */

const POLL_MS = 30_000;
const NUDGE_INTERVAL_MS = 5 * 60_000;

export class ShiftMonitor {
  private state: ShiftMonitorState = { ...INITIAL_STATE };
  private shift: ShiftDto | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private oneShotTimer: NodeJS.Timeout | null = null;
  private started = false;

  /** Called whenever the user clicks "Yes" (opens the main window) so the
   *  agent owner can plug in main-window-show logic without coupling this
   *  service to it. */
  constructor(private readonly openMainWindow: () => void) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    log.info('shift monitor started', { pollMs: POLL_MS });
    await this.refreshShift();
    // Resume after sleep / unlock invalidates time math; re-fetch + retick.
    powerMonitor.on('resume', () => {
      void this.refreshShift().then(() => this.tick());
    });
    powerMonitor.on('unlock-screen', () => this.tick());
    this.startPolling();
    this.tick();
  }

  stop(): void {
    this.started = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.oneShotTimer) clearTimeout(this.oneShotTimer);
    this.pollTimer = null;
    this.oneShotTimer = null;
    hideReadyToWork();
  }

  /** External hook so the agent can refetch when the user is reassigned
   *  in the dashboard without restarting the app. */
  async refreshShift(): Promise<void> {
    try {
      const res = await api<MyShiftResponse>('/v1/auth/me/shift');
      this.shift = res.shift;
      log.info('shift refreshed', { hasShift: this.shift !== null, name: this.shift?.name });
    } catch (err) {
      // No tokens / 401 → treat as "no shift" silently. We re-try after
      // the next powerMonitor resume / next start() call.
      log.warn('shift refresh failed (non-fatal)', { err: String(err) });
      this.shift = null;
    }
  }

  todayWindow(now = Date.now()): TodayShiftWindow | null {
    if (!this.shift) return null;
    const timeZone = getWorkspaceTimeZone();
    if (!timeZone) return null;
    const window = resolveShiftWindow(this.shift.schedule, new Date(now), timeZone);
    return window ? { name: this.shift.name, ...window } : null;
  }

  /** Called from IPC after the user clicks Yes / Not yet in the toast. */
  onUserDecision(decision: 'yes' | 'not_yet'): void {
    if (!this.shift) return;
    const now = new Date();
    const timeZone = getWorkspaceTimeZone();
    if (!timeZone) return;
    if (decision === 'yes') {
      this.state = ackToday(this.state, this.shift.schedule, now, timeZone);
      hideReadyToWork();
      this.openMainWindow();
    } else {
      this.state = snooze(this.state, now, NUDGE_INTERVAL_MS);
      hideReadyToWork();
    }
    // After a user decision, immediately reschedule for the next tick
    // boundary so the popup doesn't bounce back accidentally.
    this.tick();
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.tick(), POLL_MS);
  }

  private tick(): void {
    if (!this.shift) return;
    const timeZone = getWorkspaceTimeZone();
    if (!timeZone) return;
    // `prompting` mirrors actual visibility — refresh from the window state
    // so a manually-dismissed toast doesn't keep us pinned in `prompting`.
    this.state = { ...this.state, prompting: isReadyToWorkVisible() };

    const action = tickShiftMonitor({
      schedule: this.shift.schedule,
      bufferMin: this.shift.bufferMin,
      state: this.state,
      now: new Date(),
      timeZone,
      nudgeIntervalMs: NUDGE_INTERVAL_MS,
    });

    switch (action.kind) {
      case 'show':
        if (this.oneShotTimer) {
          clearTimeout(this.oneShotTimer);
          this.oneShotTimer = null;
        }
        showReadyToWork();
        this.state = { ...this.state, prompting: true };
        break;
      case 'hide':
        hideReadyToWork();
        this.state = expire(this.state);
        break;
      case 'schedule': {
        const ms = Math.max(0, action.nextAt - Date.now());
        // Bound to a sensible max (1 day) so a long sleep doesn't get a
        // huge integer to chew on.
        const clamped = Math.min(ms, 24 * 60 * 60_000);
        if (this.oneShotTimer) clearTimeout(this.oneShotTimer);
        this.oneShotTimer = setTimeout(() => this.tick(), clamped);
        break;
      }
      case 'noop':
      default:
        break;
    }
  }
}
