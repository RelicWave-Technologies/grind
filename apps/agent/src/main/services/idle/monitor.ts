import { powerMonitor } from 'electron';
import { getTimerService } from '../timer';
import { shouldPromptIdle, computeIdleStart } from './decide';
import { IDLE_POLL_MS } from '../../env';
import { getIdleThresholdSec } from '../agentConfig';
import { log } from '../../logger';

/**
 * Polls the OS idle timer while a timer is running and fires `onPrompt` once the
 * user has been idle past the threshold. Stays "prompting" until `resolve()` so
 * it never stacks prompts.
 */
export class IdleMonitor {
  private interval: NodeJS.Timeout | null = null;
  private prompting = false;
  private idleStartedAt = 0;

  /** `isProtected` returns true when idle should be ignored (e.g. in a meeting). */
  constructor(
    private readonly onPrompt: (idleStartedAt: number) => void,
    private readonly isProtected: () => boolean = () => false,
  ) {}

  start(): void {
    if (this.interval) return;
    log.info('idle monitor started', { thresholdSec: getIdleThresholdSec(), pollMs: IDLE_POLL_MS });
    this.interval = setInterval(() => this.tick(), IDLE_POLL_MS);
  }

  private tick(): void {
    try {
      // While in a meeting (no keyboard/mouse but actively present) don't prompt.
      if (this.isProtected()) return;
      const idleSeconds = powerMonitor.getSystemIdleTime();
      const isRunning = getTimerService().isRunning();
      if (shouldPromptIdle({ isRunning, idleSeconds, thresholdSec: getIdleThresholdSec(), prompting: this.prompting })) {
        this.prompting = true;
        this.idleStartedAt = computeIdleStart(Date.now(), idleSeconds);
        log.info('idle prompt triggered', { idleSeconds });
        this.onPrompt(this.idleStartedAt);
      }
    } catch (err) {
      log.warn('idle tick failed', { err: String(err) });
    }
  }

  getIdleStart(): number {
    return this.idleStartedAt;
  }
  resolve(): void {
    this.prompting = false;
  }
  isPrompting(): boolean {
    return this.prompting;
  }
}
