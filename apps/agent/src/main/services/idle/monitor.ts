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
  onIdle: (idleStartedAt: number) => boolean | Promise<boolean>;
}

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

  /** `isProtected` returns true when idle should be ignored (e.g. in a meeting). */
  constructor(
    private readonly handlers: IdleMonitorHandlers,
    private readonly isProtected: () => boolean = () => false,
  ) {}

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

    if (this.phase === 'IDLE_PENDING') {
      await this.presentIdlePrompt();
      return;
    }
    if (this.phase === 'IDLE_PROMPT') return;

    if (this.isProtected()) {
      this.cancelWarning();
      return;
    }

    const status = getTimerService().status();
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
    this.clearDeadline();
    this.phase = 'IDLE_PENDING';
    this.idleStartedAt = idleStartedAt;
    await this.presentIdlePrompt();
  }

  private async presentIdlePrompt(): Promise<void> {
    try {
      const accepted = await this.handlers.onIdle(this.idleStartedAt);
      this.phase = accepted ? 'IDLE_PROMPT' : 'IDLE_PENDING';
    } catch (err) {
      this.phase = 'IDLE_PENDING';
      log.warn('idle pause or prompt failed; will retry', { err: String(err) });
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

  isPrompting(): boolean {
    return this.phase !== 'NONE';
  }
}
