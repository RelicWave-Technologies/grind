import { AgentCommandWire, type AgentCommandResultRequest } from '@grind/types';

/**
 * Runs developer commands handed to this agent on the heartbeat.
 *
 * Silent by design: no notification, one log line per command. Never throws
 * into the caller and never blocks it — the heartbeat hands commands over and
 * moves on. Commands run one at a time, in the order they arrived.
 *
 * Each command runs at most once per account on this machine: its id is
 * marked before it starts and its outcome is stored after. A command the
 * server hands out again (it heard nothing back) is answered from the stored
 * outcome instead of being run a second time. One marked but with no stored
 * outcome was cut short (the app quit mid-run) and is reported as FAILED.
 */

export type CommandOutcome = Pick<AgentCommandResultRequest, 'status' | 'result' | 'error'>;

interface StoredOutcome extends CommandOutcome {
  posted: boolean;
}

/** Owner-scoped persistence; the timer store's meta table in production. */
export interface RemoteCommandMemory {
  /** True the first time `id` is marked. */
  markStarted(id: string): boolean;
  load(id: string): string | null;
  save(id: string, value: string): void;
}

export interface RemoteCommandLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface RemoteCommandRunnerDeps {
  /** Null while signed out: nothing runs, the server hands it out again later. */
  memory(): RemoteCommandMemory | null;
  execute(command: AgentCommandWire): Promise<CommandOutcome>;
  post(id: string, outcome: CommandOutcome): Promise<void>;
  log: RemoteCommandLogger;
  now?: () => number;
}

/** The stored outcome as it is posted: only the fields that are set. */
function parseStored(raw: string | null): CommandOutcome | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredOutcome>;
    if (value.status !== 'DONE' && value.status !== 'FAILED') return null;
    return {
      status: value.status,
      ...(value.result && typeof value.result === 'object' ? { result: value.result } : {}),
      ...(typeof value.error === 'string' ? { error: value.error } : {}),
    };
  } catch {
    return null;
  }
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500) || 'unknown_error';
}

export class RemoteCommandRunner {
  private readonly queue = new Map<string, AgentCommandWire>();
  /** Outcomes whose post failed; retried on every hand-over until one lands. */
  private readonly unposted = new Map<string, CommandOutcome>();
  private running: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: RemoteCommandRunnerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Take the heartbeat's command list (anything; unknown shapes are dropped)
   * and work through it in the background. Returns the in-flight run so tests
   * can await it; production callers do not.
   */
  handle(commands: unknown): Promise<void> {
    try {
      for (const command of parseCommands(commands)) {
        if (!this.queue.has(command.id)) this.queue.set(command.id, command);
      }
    } catch {
      // Malformed input never reaches the heartbeat.
    }
    if (this.running) return this.running;
    if (this.queue.size === 0 && this.unposted.size === 0) return Promise.resolve();
    this.running = this.drain()
      .catch((err) => this.deps.log.warn('remote command runner failed', { err: errorText(err) }))
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async drain(): Promise<void> {
    for (const [id, outcome] of [...this.unposted]) {
      const memory = this.deps.memory();
      if (!memory) return;
      await this.post(memory, id, outcome);
    }
    for (;;) {
      const next = this.queue.values().next();
      if (next.done) return;
      const command = next.value;
      this.queue.delete(command.id);
      await this.runOne(command);
    }
  }

  private async runOne(command: AgentCommandWire): Promise<void> {
    const memory = this.deps.memory();
    if (!memory) return;
    const stored = parseStored(memory.load(command.id));
    if (stored) {
      // Handed out again: the server never got (or never kept) the result.
      await this.post(memory, command.id, stored);
      return;
    }
    if (!memory.markStarted(command.id)) {
      const interrupted: CommandOutcome = { status: 'FAILED', error: 'interrupted: the app stopped before the command finished' };
      this.store(memory, command.id, interrupted, false);
      await this.post(memory, command.id, interrupted);
      return;
    }
    const startedAt = this.now();
    let outcome: CommandOutcome;
    try {
      outcome = await this.deps.execute(command);
    } catch (err) {
      outcome = { status: 'FAILED', error: errorText(err) };
    }
    this.store(memory, command.id, outcome, false);
    this.deps.log.info('remote command finished', {
      id: command.id,
      type: command.type,
      status: outcome.status,
      durationMs: this.now() - startedAt,
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(outcome.result ? { result: outcome.result } : {}),
    });
    await this.post(memory, command.id, outcome);
  }

  private async post(memory: RemoteCommandMemory, id: string, outcome: CommandOutcome): Promise<void> {
    try {
      await this.deps.post(id, outcome);
      this.unposted.delete(id);
      this.store(memory, id, outcome, true);
    } catch (err) {
      this.unposted.set(id, outcome);
      this.deps.log.warn('remote command result not delivered; will retry', { id, err: errorText(err) });
    }
  }

  private store(memory: RemoteCommandMemory, id: string, outcome: CommandOutcome, posted: boolean): void {
    try {
      memory.save(id, JSON.stringify({ ...outcome, posted } satisfies StoredOutcome));
    } catch (err) {
      this.deps.log.warn('remote command outcome not stored', { id, err: errorText(err) });
    }
  }
}

function parseCommands(raw: unknown): AgentCommandWire[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentCommandWire[] = [];
  for (const item of raw) {
    const parsed = AgentCommandWire.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}
