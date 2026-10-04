import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Rng } from '../prng';
import type { FnSpec } from '../fixture';
import { asyncSpec } from './asyncSpec';
import { DENSE_ZONES, MS_PER_DAY, denseTransitions } from './tzZones';
import { freshService } from '../tzStubs/register';
import * as stubs from '../tzStubs/stubs';
import { app } from '../legacyStubs/electron';

/**
 * Golden output for `services/workspaceTime.ts` (SC-57): the REAL service, behind
 * stubs for Electron's `app.getPath`, the token store, the logger and the server
 * clock, over a sequence of calls. It reads and writes a real `workspace-time.json`
 * in a throwaway directory. The business-day maths underneath is `gen/tz.ts`'s.
 */

type Op =
  | { op: 'init' }
  | { op: 'apply'; timeZone: string; workspaceId: string }
  | { op: 'clear' }
  | { op: 'session'; workspaceId: string | null }
  | { op: 'context'; nowMs: number }
  | { op: 'contextDefault'; clockMs: number };

interface ScenarioIn {
  /** The text of workspace-time.json before the service starts; null = no file. */
  cacheFile: string | null;
  /** The workspace the stored session belongs to; null = signed out. */
  workspaceId: string | null;
  ops: Op[];
}

interface Service {
  initializeWorkspaceTime(): Promise<void>;
  applyServerWorkspaceTimeZone(value: string, expectedWorkspaceId: string): Promise<void>;
  clearWorkspaceTimeSession(): void;
  getWorkspaceTimeContext(now?: number): unknown;
  getWorkspaceTimeZone(): string | null;
}

const sessionOf = (workspaceId: string | null) =>
  workspaceId === null ? null : { accessToken: 'at', refreshToken: 'rt', userId: 'user_1', workspaceId };

/** The failure a call ends in, reduced to something stable: a zod failure is just "invalid timezone". */
function failure(err: unknown): string {
  if (err instanceof Error && err.name === 'ZodError') return 'zod_invalid';
  return err instanceof Error ? err.message : String(err);
}

const runScenario = (input: ScenarioIn): Promise<unknown[]> => stubs.exclusive(() => scenario(input));

async function scenario(input: ScenarioIn): Promise<unknown[]> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'timo-parity-wt-'));
  const file = path.join(dir, 'workspace-time.json');
  try {
    (app as { getPath?: () => string }).getPath = () => dir;
    if (input.cacheFile !== null) await fs.writeFile(file, input.cacheFile);
    stubs.world.session = sessionOf(input.workspaceId);
    stubs.world.now = 0;
    const service = await freshService<Service>('workspaceTime.ts');
    const out: unknown[] = [];
    for (const op of input.ops) {
      const step: { [key: string]: unknown } = {};
      try {
        if (op.op === 'init') await service.initializeWorkspaceTime();
        else if (op.op === 'apply') await service.applyServerWorkspaceTimeZone(op.timeZone, op.workspaceId);
        else if (op.op === 'clear') service.clearWorkspaceTimeSession();
        else if (op.op === 'session') stubs.world.session = sessionOf(op.workspaceId);
        else if (op.op === 'context') step.context = service.getWorkspaceTimeContext(op.nowMs);
        else {
          stubs.world.now = op.clockMs;
          step.context = service.getWorkspaceTimeContext();
        }
      } catch (err) {
        step.error = failure(err);
      }
      step.timeZone = service.getWorkspaceTimeZone();
      step.file = await fs.readFile(file, 'utf8').catch(() => null);
      out.push(step);
    }
    return out;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------

const CACHE_FILES: ReadonlyArray<string | null> = [
  null,
  JSON.stringify({ workspaceId: 'workspace_1', timeZone: 'Asia/Kolkata' }),
  JSON.stringify({ workspaceId: 'workspace_1', timeZone: ' Asia/Kolkata ' }),
  JSON.stringify({ workspaceId: 'workspace_1', timeZone: 'not/a-zone' }),
  JSON.stringify({ workspaceId: 'workspace_1', timeZone: '' }),
  JSON.stringify({ workspaceId: 'workspace_1', timeZone: 5 }),
  JSON.stringify({ workspaceId: 'workspace_1' }),
  JSON.stringify({ timeZone: 'UTC' }),
  JSON.stringify({ workspaceId: '', timeZone: 'UTC' }),
  JSON.stringify({ workspaceId: 7, timeZone: 'UTC' }),
  JSON.stringify({ workspaceId: 'workspace_previous', timeZone: 'America/New_York' }),
  JSON.stringify({ workspaceId: 'workspace_1', timeZone: 'America/Sao_Paulo' }),
  JSON.stringify({ workspaceId: 'workspace_1', timeZone: 'Etc/GMT+5', extra: true }),
  JSON.stringify({ workspaceId: 'workspace_1', timeZone: '+05:30' }),
  JSON.stringify({ workspaceId: 'workspace_1', timeZone: 'IST' }),
  'not json', '', '[]', 'null', '7', '"x"', '{"workspaceId":"workspace_1","timeZone":"UTC"',
];

const WORKSPACES: ReadonlyArray<string | null> = ['workspace_1', 'workspace_1', 'workspace_1', 'workspace_2', null];
const APPLY_ZONES = [
  ...DENSE_ZONES, ' Asia/Kolkata ', 'asia/kolkata', 'UTC', '', ' ', 'not/a-zone', 'Z', '+25:00', 'GMT+5', `${' '.repeat(90)}UTC`, 'Africa/Casablanca\n', 'America/Havana',
];

let changes: Map<string, number[]> | null = null;
function nearChange(rng: Rng, zone: string): number {
  if (!changes) {
    changes = new Map();
    for (const t of denseTransitions()) changes.set(t.zone, [...(changes.get(t.zone) ?? []), t.at]);
  }
  const list = changes.get(zone) ?? [];
  const base = list.length > 0 && rng.chance(0.5) ? rng.pick(list) : Date.UTC(2026, 0, 1) + Math.floor(rng.next() * 366 * MS_PER_DAY);
  return base + rng.pick([-MS_PER_DAY, -1, 0, 1, MS_PER_DAY, 3_600_000, -3_600_000, 12 * 3_600_000]);
}

function randomOp(rng: Rng, zone: string): Op {
  return rng.weighted<() => Op>([
    [() => ({ op: 'context', nowMs: nearChange(rng, zone) + (rng.chance(0.15) ? 0.5 : 0) }), 45],
    [() => ({ op: 'apply', timeZone: zone, workspaceId: rng.pick(['workspace_1', 'workspace_1', 'workspace_2']) }), 18],
    [() => ({ op: 'init' }), 8],
    [() => ({ op: 'clear' }), 7],
    [() => ({ op: 'session', workspaceId: rng.pick(WORKSPACES) }), 6],
    [() => ({ op: 'contextDefault', clockMs: nearChange(rng, zone) }), 6],
    [() => ({ op: 'context', nowMs: rng.pick([8.64e15 + 1, -8.64e15 - 1, 9e15, 0]) }), 4],
    [() => ({ op: 'apply', timeZone: rng.pick(APPLY_ZONES), workspaceId: 'workspace_1' }), 6],
  ])();
}

function randomScenario(rng: Rng): ScenarioIn {
  const zone = rng.pick(DENSE_ZONES);
  const ops: Op[] = [];
  for (let i = rng.int(2, 9); i > 0; i--) ops.push(randomOp(rng, zone));
  return { cacheFile: rng.pick(CACHE_FILES), workspaceId: rng.pick(WORKSPACES), ops };
}

function edgeScenarios(): ScenarioIn[] {
  const at = Date.parse('2026-07-14T20:00:00.000Z');
  const out: ScenarioIn[] = [
    // The four cases of workspaceTime.test.ts.
    { cacheFile: null, workspaceId: 'workspace_1', ops: [{ op: 'apply', timeZone: 'Asia/Kolkata', workspaceId: 'workspace_1' }, { op: 'context', nowMs: at }] },
    { cacheFile: CACHE_FILES[1]!, workspaceId: 'workspace_1', ops: [{ op: 'init' }, { op: 'context', nowMs: Date.parse('2026-07-15T00:00:00.000Z') }] },
    { cacheFile: CACHE_FILES[3]!, workspaceId: 'workspace_1', ops: [{ op: 'init' }, { op: 'contextDefault', clockMs: at }] },
    { cacheFile: CACHE_FILES[10]!, workspaceId: 'workspace_1', ops: [{ op: 'init' }, { op: 'contextDefault', clockMs: at }] },
    { cacheFile: null, workspaceId: 'workspace_1', ops: [{ op: 'apply', timeZone: 'Asia/Kolkata', workspaceId: 'workspace_1' }, { op: 'clear' }, { op: 'contextDefault', clockMs: at }] },
  ];
  for (const cacheFile of CACHE_FILES) out.push({ cacheFile, workspaceId: 'workspace_1', ops: [{ op: 'init' }, { op: 'context', nowMs: at }, { op: 'clear' }, { op: 'init' }, { op: 'context', nowMs: at }] });
  out.push({ cacheFile: null, workspaceId: null, ops: [{ op: 'init' }, { op: 'apply', timeZone: 'UTC', workspaceId: 'workspace_1' }, { op: 'context', nowMs: at }] });
  out.push({ cacheFile: null, workspaceId: 'workspace_2', ops: [{ op: 'apply', timeZone: 'UTC', workspaceId: 'workspace_1' }, { op: 'context', nowMs: at }] });
  out.push({ cacheFile: null, workspaceId: 'workspace_1', ops: [{ op: 'apply', timeZone: 'UTC', workspaceId: 'workspace_1' }, { op: 'apply', timeZone: 'UTC', workspaceId: 'workspace_1' }, { op: 'apply', timeZone: 'Asia/Tokyo', workspaceId: 'workspace_1' }] });
  out.push({ cacheFile: null, workspaceId: 'workspace_1', ops: [{ op: 'apply', timeZone: 'not/a-zone', workspaceId: 'workspace_1' }, { op: 'apply', timeZone: '', workspaceId: 'workspace_1' }, { op: 'apply', timeZone: ' UTC ', workspaceId: 'workspace_1' }] });
  // A zone with no midnight on some day: no business day that day.
  const noMidnight = Date.UTC(2026, 2, 8, 12);
  out.push({ cacheFile: null, workspaceId: 'workspace_1', ops: [{ op: 'apply', timeZone: 'America/Havana', workspaceId: 'workspace_1' }, { op: 'context', nowMs: Date.UTC(2026, 2, 8, 12) }, { op: 'context', nowMs: noMidnight - MS_PER_DAY }] });
  out.push({ cacheFile: null, workspaceId: 'workspace_1', ops: [{ op: 'apply', timeZone: 'Pacific/Apia', workspaceId: 'workspace_1' }, { op: 'context', nowMs: Date.UTC(2011, 11, 30, 10) }, { op: 'context', nowMs: Date.UTC(2011, 11, 29, 10) }] });
  return out;
}

export const specs: FnSpec<any>[] = [
  await asyncSpec<ScenarioIn>({ module: 'tz', fn: 'workspaceTimeScenario', edge: edgeScenarios, random: randomScenario, run: runScenario }),
];
