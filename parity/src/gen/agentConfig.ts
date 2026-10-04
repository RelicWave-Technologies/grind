import { AgentConfigResponse } from '@grind/types';
import type { Rng } from '../prng';
import type { FnSpec } from '../fixture';
import { asyncSpec } from './asyncSpec';
import { DENSE_ZONES } from './tzZones';
import { freshService } from '../tzStubs/register';
import * as stubs from '../tzStubs/stubs';

/**
 * Golden output for the agent's runtime config (SC-76):
 *
 *  - `agentConfigResponse`: the zod schema `AgentConfigResponse.safeParse`, all or nothing.
 *  - `agentConfigRefresh`: the REAL `services/agentConfig.ts` (fetch, parse, apply, notify),
 *    run through `refreshAgentConfig()` behind stubs for the API, the token store, the
 *    logger, `env` and the workspace-time service, over a sequence of server responses.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const FIELD_VALUES: Record<string, Json[]> = {
  configVersion: ['', 'v1', 'config_1', 'é', ' ', 'x'.repeat(300), null, 5, true, []],
  heartbeatIntervalSec: [14, 15, 16, 60, 599, 600, 601, 0, -1, 60.5, 15.0000001, '60', null, true, 1e9],
  screenshotIntervalMin: [0, 1, 2, 3, 4, 5, 1.5, 2.9999999, '3', null, -1, true, 3.0],
  idleThresholdMin: [0, 1, 2, 5, 119, 120, 121, 5.5, '5', null, -1, 1e9],
  idleWarningSeconds: [null, 4, 5, 6, 30, 119, 120, 121, '5', 5.5, 0, -5, true, 299, 300, 301],
  captureApps: [true, false, null, 'true', 1, 0, [], {}],
  captureTitles: [true, false, null, 'true', 1, 0],
  captureUrls: [true, false, null, 'false', 1, 0],
  todayLedgerMode: ['OFF', 'SHADOW', 'VISIBLE', 'off', 'Visible', '', null, 1, true, ['OFF']],
  dashboardUrl: ['', 'https://timo.example', 'https://timo.example/', null, 5, true, 'x'.repeat(5000)],
  workspaceTimezone: [
    'UTC', ' Asia/Kolkata ', 'Asia/Kolkata', 'asia/kolkata', '', ' ', '\n', null, 5, 'Mars/Olympus', '+05:30', 'Etc/GMT+5', 'IST', 'America/New_York',
    'a'.repeat(81), `${' '.repeat(100)}UTC`, 'UTC ', ' UTC', 'UTC\u0085', 'Z', 'GMT+5', true, [],
  ],
};
const FIELDS = Object.keys(FIELD_VALUES);

function baseResponse(rng: Rng): { [key: string]: Json } {
  const warn = rng.chance(0.5) ? null : rng.int(5, 120);
  return {
    configVersion: rng.chance(0.2) ? '' : `config_${rng.int(1, 9)}`,
    heartbeatIntervalSec: rng.int(15, 600),
    screenshotIntervalMin: rng.int(1, 3),
    idleThresholdMin: rng.pick([1, 2, 5, 5, 10, 120, rng.int(1, 120)]),
    idleWarningSeconds: warn,
    captureApps: rng.chance(0.5),
    captureTitles: rng.chance(0.5),
    captureUrls: rng.chance(0.5),
    todayLedgerMode: rng.pick(['OFF', 'SHADOW', 'VISIBLE']),
    dashboardUrl: rng.chance(0.3) ? '' : 'https://timo.example',
    workspaceTimezone: rng.pick(DENSE_ZONES),
  };
}

/** A server response: usually valid, sometimes missing keys (defaults) or one bad value. */
function randomResponse(rng: Rng): Json {
  if (rng.chance(0.03)) return rng.pick<Json>([null, [], 'x', 5, true, [{}], [[]], 0, '']);
  const payload = baseResponse(rng);
  for (const key of FIELDS) if (rng.chance(0.07)) delete payload[key];
  if (rng.chance(0.4)) {
    const key = rng.pick(FIELDS);
    payload[key] = rng.pick(FIELD_VALUES[key]!);
  }
  if (rng.chance(0.08)) {
    const key = rng.pick(FIELDS);
    payload[key] = rng.pick(FIELD_VALUES[key]!);
  }
  if (rng.chance(0.1)) payload.heartbeatIntervalSec = rng.pick([15, 600, 14, 601]);
  if (rng.chance(0.08)) payload.extra = rng.pick<Json>([1, 'x', null, { nested: true }]);
  return payload;
}

function edgeResponses(): Json[] {
  const valid = {
    configVersion: 'config_1', heartbeatIntervalSec: 60, screenshotIntervalMin: 3, idleThresholdMin: 5, captureApps: false, captureTitles: false,
    captureUrls: false, todayLedgerMode: 'SHADOW', dashboardUrl: 'https://timo.example', workspaceTimezone: 'Asia/Kolkata',
  };
  const out: Json[] = [valid, {}, { ...valid, idleWarningSeconds: 30 }, { ...valid, idleWarningSeconds: null }];
  for (const key of FIELDS) {
    for (const value of FIELD_VALUES[key]!) out.push({ ...valid, [key]: value });
    const without: { [key: string]: Json } = { ...valid };
    delete without[key];
    out.push(without);
  }
  out.push(null, [], 'x', 5, true, [{ ...valid }]);
  // Captures: titles and URLs only count when apps are on.
  for (const apps of [true, false]) for (const titles of [true, false]) for (const urls of [true, false]) out.push({ ...valid, captureApps: apps, captureTitles: titles, captureUrls: urls });
  // The idle warning against the threshold: strictly below counts.
  for (const [threshold, warning] of [[5, 299], [5, 300], [5, 301], [1, 59], [1, 60], [1, 5], [2, 120], [120, 120]] as const) out.push({ ...valid, idleThresholdMin: threshold, idleWarningSeconds: warning });
  return out;
}

// ---------------------------------------------------------------------------

interface ResponseIn { raw: Json }

// ---------------------------------------------------------------------------

type Step = { response: Json } | { fetchError: true };
interface RefreshIn {
  env: { screenshotIntervalSec: number; idleThresholdSec: number; shotLocked: boolean; idleLocked: boolean };
  steps: Step[];
}

interface Service {
  refreshAgentConfig(): Promise<void>;
  onAgentConfigChange(listener: (change: unknown) => void): () => void;
  getAgentConfigVersion(): string | null;
  getScreenshotIntervalSec(): number;
  getIdleThresholdSec(): number;
  getIdleWarningSeconds(): number | null;
  getCapturePolicy(): unknown;
  getTodayLedgerMode(): string;
  getDashboardUrl(): string;
}

const SESSION = { accessToken: 'at', refreshToken: 'rt', userId: 'user_1', workspaceId: 'workspace_1' };

const runRefresh = (input: RefreshIn): Promise<unknown[]> => stubs.exclusive(() => refresh(input));

async function refresh(input: RefreshIn): Promise<unknown[]> {
  stubs.setEnv(input.env);
  stubs.world.session = SESSION;
  const service = await freshService<Service>('agentConfig.ts');
  let change: unknown = null;
  const off = service.onAgentConfigChange((c) => { change = c; });
  const out: unknown[] = [];
  for (const step of input.steps) {
    change = null;
    stubs.world.timeZoneCalls = [];
    stubs.world.responseError = 'fetchError' in step ? new Error('network down') : null;
    stubs.world.response = 'response' in step ? step.response : undefined;
    await service.refreshAgentConfig();
    out.push({
      timeZoneApplied: stubs.world.timeZoneCalls[0] ?? null,
      change,
      state: {
        configVersion: service.getAgentConfigVersion(),
        screenshotIntervalSec: service.getScreenshotIntervalSec(),
        idleThresholdSec: service.getIdleThresholdSec(),
        idleWarningSeconds: service.getIdleWarningSeconds(),
        capture: service.getCapturePolicy(),
        todayLedgerMode: service.getTodayLedgerMode(),
        dashboardUrl: service.getDashboardUrl(),
      },
    });
  }
  off();
  return out;
}

function randomRefresh(rng: Rng): RefreshIn {
  const env = {
    screenshotIntervalSec: rng.pick([180, 180, 600, 15, 60, 3600]),
    idleThresholdSec: rng.pick([300, 300, 20, 60, 7200]),
    shotLocked: rng.chance(0.2),
    idleLocked: rng.chance(0.2),
  };
  const steps: Step[] = [];
  for (let i = rng.int(1, 4); i > 0; i--) {
    if (rng.chance(0.08)) steps.push({ fetchError: true });
    else if (rng.chance(0.25) && steps.length > 0) steps.push(rng.pick(steps)); // the same response again: no change to announce
    else steps.push({ response: randomResponse(rng) });
  }
  return { env, steps };
}

function edgeRefresh(): RefreshIn[] {
  const env = { screenshotIntervalSec: 180, idleThresholdSec: 300, shotLocked: false, idleLocked: false };
  const [valid, , withWarning] = edgeResponses();
  const out: RefreshIn[] = [
    { env, steps: [{ response: valid! }] },
    { env, steps: [{ response: valid! }, { response: valid! }] },
    { env, steps: [{ response: valid! }, { response: { ...(valid as object), todayLedgerMode: 'VISIBLE' } }] },
    { env, steps: [{ response: valid! }, { response: { bad: true, screenshotIntervalMin: 9 } }, { response: withWarning! }] },
    { env, steps: [{ fetchError: true }, { response: valid! }, { fetchError: true }] },
    { env, steps: [{ response: {} }] },
    { env, steps: [{ response: null }, { response: [] }] },
    { env: { ...env, shotLocked: true, idleLocked: true }, steps: [{ response: valid! }] },
    { env: { ...env, shotLocked: true }, steps: [{ response: valid! }, { response: { ...(valid as object), idleThresholdMin: 1, idleWarningSeconds: 59 } }] },
    { env: { screenshotIntervalSec: 15, idleThresholdSec: 20, shotLocked: true, idleLocked: true }, steps: [{ response: { ...(valid as object), idleWarningSeconds: 30 } }] },
  ];
  for (const response of edgeResponses()) out.push({ env, steps: [{ response }] });
  return out;
}

export const specs: FnSpec<any>[] = [
  {
    module: 'agentConfig',
    fn: 'agentConfigResponse',
    edge: (): ResponseIn[] => edgeResponses().map((raw) => ({ raw })),
    random: (rng: Rng): ResponseIn => ({ raw: randomResponse(rng) }),
    call: ({ raw }: ResponseIn) => {
      const r = AgentConfigResponse.safeParse(raw);
      return r.success ? { ok: true, data: r.data } : { ok: false };
    },
  },
  await asyncSpec<RefreshIn>({ module: 'agentConfig', fn: 'agentConfigRefresh', edge: edgeRefresh, random: randomRefresh, run: runRefresh }),
];
