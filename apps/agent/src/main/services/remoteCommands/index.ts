import { release } from 'node:os';
import type { AgentCommandWire } from '@grind/types';
import { log } from '../../logger';
import { api, HttpError } from '../apiClient';
import { agentVersion } from '../agentIdentity';
import { drainTimerSyncNow, getTimerService } from '../timer';
import { drainActivityNow, getActivityStore } from '../activity';
import { getScreenshotStore } from '../capture';
import { drainUploads } from '../capture/uploader';
import { getWorkspaceTimeZone } from '../workspaceTime';
import { RemoteCommandRunner, type CommandOutcome, type RemoteCommandMemory } from './runner';
import { runResync } from './resync';

/**
 * Production wiring for developer commands (see ./runner and ./resync).
 * The heartbeat calls {@link handleRemoteCommands} with whatever its response
 * carried; this never throws and never makes the heartbeat wait.
 */

function device() {
  const version = typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : release();
  return { appVersion: agentVersion(), os: `${process.platform} ${version}`, arch: process.arch };
}

function memory(): RemoteCommandMemory | null {
  const timer = getTimerService();
  if (!timer.currentOwner()) return null;
  return {
    markStarted: (id) => timer.markOnce(`command:${id}`),
    load: (id) => timer.getNote(`command:${id}`),
    save: (id, value) => timer.setNote(`command:${id}`, value),
  };
}

function kickDrains(): void {
  const quietly = (what: string, run: () => Promise<unknown>) => {
    void Promise.resolve()
      .then(run)
      .catch((err) => log.warn('remote resync drain trigger failed', { what, err: String(err) }));
  };
  quietly('timer', () => drainTimerSyncNow('manual'));
  quietly('activity', () => drainActivityNow('manual'));
  quietly('screenshots', () => drainUploads());
}

async function execute(command: AgentCommandWire): Promise<CommandOutcome> {
  if (command.type !== 'RESYNC') return { status: 'FAILED', error: `unsupported_command:${command.type}` };
  const timer = getTimerService();
  const result = await runResync(command.params, {
    owner: () => timer.currentOwner(),
    timeZone: getWorkspaceTimeZone,
    timer,
    activity: getActivityStore(),
    screenshots: getScreenshotStore(),
    kickDrains,
    device,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  return { status: 'DONE', result: { ...result } };
}

async function post(id: string, outcome: CommandOutcome): Promise<void> {
  try {
    await api(`/v1/agent/commands/${encodeURIComponent(id)}/result`, {
      method: 'POST',
      body: outcome,
      timeoutMs: 15_000,
    });
  } catch (err) {
    // Gone, or not this account's: retrying can never land it.
    if (err instanceof HttpError && (err.status === 404 || err.status === 400)) {
      log.warn('remote command result rejected; dropping it', { id, status: err.status });
      return;
    }
    throw err;
  }
}

const runner = new RemoteCommandRunner({ memory, execute, post, log });

export function handleRemoteCommands(commands: unknown): void {
  try {
    void runner.handle(commands);
  } catch (err) {
    log.warn('remote commands not handled', { err: String(err) });
  }
}
