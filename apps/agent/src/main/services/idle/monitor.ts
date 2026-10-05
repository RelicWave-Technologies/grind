import { powerMonitor } from 'electron';
import { getTimerService } from '../timer';
import { computeIdleStart } from './decide';
import { IDLE_POLL_MS } from '../../env';
import { getIdleThresholdSec, getIdleWarningSeconds } from '../agentConfig';
import { log } from '../../logger';

export interface IdleWarningInfo {
  idleStartedAt: number;
  deadlineAt: number;
}

export interface IdleMonitorHandlers {
  onWarning: (info: IdleWarningInfo) => boolean | Promise<boolean>;
  onWarningCancelled: () => void;
  /** Pause the timer at the idle boundary. Called once per idle spell. */
  onIdlePause: (idleStartedAt: number) => Promise<void>;
  /** Ask for the idle prompt. False when another prompt owns the screen. */
  onIdlePrompt: (idleStartedAt: number) => boolean;
}

/**
 * NONE → WARNING (optional) → IDLE_PENDING → IDLE_PROMPT → NONE.
 *
 * IDLE_PENDING means the timer has been paused but the prompt could not be
 * shown yet (another prompt owned the screen). Only the prompt is retried from
 * there — never the pause. Re-pausing on every poll is what froze a timer the
 * person had just resumed from the popover.
 *
 * IDLE_PROMPT ends when the coordinator stops showing the idle prompt, by any
 * path; the owner wires that to `resolve()`. Until then idle detection is off.
 */
type IdlePhase = 'NONE' | 'WARNING' | 'IDLE_PENDING' | 'IDLE_PROMPT';

/**
 * Two-stage OS-idle monitor. Selected users receive a warning while their
 * timer is still accruing; crossing the real threshold uses the existing
 * durable idle pause. The absolute deadline is owned by main process so a
 * hidden/throttled renderer cannot delay the pause.
 */
export class IdleMonitor {
  private interval: NodeJS.Timeout | null = null;
  private deadlineTimer: NodeJS.Timeout | null = null;
  private phase: IdlePhase = 'NONE';
  private suspended = false;
  private ticking = false;
  private idleStartedAt = 0;
  private warningTriggerSec = 0;
  private thresholdSec = 0;
  private deadlineAt = 0;

  constructor(private readonly handlers: IdleMonitorHandlers) {}

  start(): void {
    if (this.interval) return;
    log.info('idle monitor started', {
      thresholdSec: getIdleThresholdSec(),
      warningSeconds: getIdleWarningSeconds(),
      pollMs: IDLE_POLL_MS,
    });
    this.interval = setInterval(() => void this.tick(), IDLE_POLL_MS);
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tickOnce();
    } catch (err) {
      log.warn('idle tick failed', { err: String(err) });
    } finally {
      this.ticking = false;
    }
  }

  private async tickOnce(): Promise<void> {
    if (this.suspended) return;
    if (this.phase === 'IDLE_PROMPT') return;

    const status = getTimerService().status();
    if (this.phase === 'IDLE_PENDING') {
      // Our pause closed the open segment, so a timer that is accruing now was
      // resumed (or restarted) since — the idle spell has been answered. A
      // stopped timer has nothing left to ask about either.
      if (status.state !== 'RUNNING' || !status.paused) {
        this.reset();
        return;
      }
      this.requestIdlePrompt();
      return;
    }

    const isAccruing = status.state === 'RUNNING' && !status.paused;
    if (!isAccruing) {
      this.cancelWarning();
      return;
    }

    const idleSeconds = powerMonitor.getSystemIdleTime();
    if (this.phase === 'WARNING') {
      if (idleSeconds < this.warningTriggerSec) {
        this.cancelWarning();
        return;
      }
      if (Date.now() >= this.deadlineAt || idleSeconds >= this.thresholdSec) {
        await this.beginIdlePause(this.idleStartedAt);
      }
      return;
    }

    const thresholdSec = getIdleThresholdSec();
    if (idleSeconds >= thresholdSec) {
      await this.beginIdlePause(computeIdleStart(Date.now(), idleSeconds));
      return;
    }

    const warningSeconds = getIdleWarningSeconds();
    if (warningSeconds == null) return;
    const warningTriggerSec = thresholdSec - warningSeconds;
    if (idleSeconds < warningTriggerSec) return;

    const idleStartedAt = computeIdleStart(Date.now(), idleSeconds);
    const deadlineAt = idleStartedAt + thresholdSec * 1000;
    this.phase = 'WARNING';
    this.idleStartedAt = idleStartedAt;
    this.warningTriggerSec = warningTriggerSec;
    this.thresholdSec = thresholdSec;
    this.deadlineAt = deadlineAt;
    try {
      const accepted = await this.handlers.onWarning({ idleStartedAt, deadlineAt });
      if (!accepted) {
        this.reset();
        return;
      }
      this.armDeadline(deadlineAt);
      log.info('idle warning presented', { idleSeconds, warningSeconds, thresholdSec });
    } catch (err) {
      this.reset();
      log.warn('idle warning failed; reset state to retry', { err: String(err) });
    }
  }

  private async beginIdlePause(idleStartedAt: number): Promise<void> {
    try {
      await this.handlers.onIdlePause(idleStartedAt);
    } catch (err) {
      // Phase unchanged: the next poll sees the same idle and tries again.
      log.warn('idle pause failed; will retry', { err: String(err) });
      return;
    }
    // The machine went away while the pause was being written; the away
    // handling owns what happens next.
    if (this.suspended) return;
    this.clearDeadline();
    this.phase = 'IDLE_PENDING';
    this.idleStartedAt = idleStartedAt;
    this.requestIdlePrompt();
  }

  private requestIdlePrompt(): void {
    try {
      const shown = this.handlers.onIdlePrompt(this.idleStartedAt);
      if (this.phase === 'IDLE_PENDING') this.phase = shown ? 'IDLE_PROMPT' : 'IDLE_PENDING';
    } catch (err) {
      log.warn('idle prompt failed; will retry', { err: String(err) });
    }
  }

  private armDeadline(deadlineAt: number): void {
    this.clearDeadline();
    this.deadlineTimer = setTimeout(
      () => void this.tick(),
      Math.max(0, deadlineAt - Date.now()),
    );
    this.deadlineTimer.unref?.();
  }

  private clearDeadline(): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
  }

  private cancelWarning(): void {
    if (this.phase !== 'WARNING') return;
    this.handlers.onWarningCancelled();
    this.reset();
  }

  private reset(): void {
    this.clearDeadline();
    this.phase = 'NONE';
    this.idleStartedAt = 0;
    this.warningTriggerSec = 0;
    this.thresholdSec = 0;
    this.deadlineAt = 0;
  }

  resolve(): void {
    this.reset();
  }

  noteActivity(): void {
    this.cancelWarning();
  }

  suspend(): void {
    this.suspended = true;
    if (this.phase === 'WARNING') this.handlers.onWarningCancelled();
    this.reset();
  }

  resume(): void {
    this.suspended = false;
    this.reset();
  }
}
