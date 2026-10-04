/**
 * The boot state of the fake desktop app. A scenario is carried in the query
 * string of every lab surface URL, so a surface opened alone looks exactly like
 * its frame in the gallery. Changing a scenario re-seeds the fake world and
 * reloads the surfaces; clicks inside a surface change the world live instead.
 */
export const SCENARIO_OPTIONS = {
  auth: ['in', 'out'],
  login: ['success', 'pending', 'error'],
  timer: ['idle', 'running', 'paused'],
  day: ['busy', 'empty'],
  lark: ['connected', 'disconnected', 'reauth', 'offline', 'unconfigured'],
  perms: ['ready', 'grant', 'restart'],
  update: ['current', 'downloading', 'ready'],
  notice: ['off', 'sleep', 'shutdown'],
  shots: ['uploaded', 'uploading', 'failed'],
  wtime: ['synced', 'syncing'],
  theme: ['light', 'dark', 'system'],
  pill: ['light', 'dark'],
} as const;

export type ScenarioField = keyof typeof SCENARIO_OPTIONS;
export type Scenario = { [K in ScenarioField]: (typeof SCENARIO_OPTIONS)[K][number] };

export const SCENARIO_FIELDS = Object.keys(SCENARIO_OPTIONS) as ScenarioField[];

export const DEFAULT_SCENARIO: Scenario = {
  auth: 'in',
  login: 'success',
  timer: 'running',
  day: 'busy',
  lark: 'connected',
  perms: 'ready',
  update: 'current',
  notice: 'off',
  shots: 'uploaded',
  wtime: 'synced',
  theme: 'light',
  pill: 'light',
};

function isOption<K extends ScenarioField>(field: K, value: string | null): value is Scenario[K] {
  return value !== null && (SCENARIO_OPTIONS[field] as readonly string[]).includes(value);
}

/** Unknown or missing values fall back to the default, never throw. */
export function scenarioFromParams(params: URLSearchParams, base: Scenario = DEFAULT_SCENARIO): Scenario {
  const next = { ...base };
  for (const field of SCENARIO_FIELDS) {
    const value = params.get(field);
    if (isOption(field, value)) (next as Record<ScenarioField, string>)[field] = value;
  }
  return next;
}

/** Writes only the fields that differ from the default, so URLs stay short. */
export function scenarioToParams(scenario: Scenario, into = new URLSearchParams()): URLSearchParams {
  for (const field of SCENARIO_FIELDS) {
    if (scenario[field] !== DEFAULT_SCENARIO[field]) into.set(field, scenario[field]);
    else into.delete(field);
  }
  return into;
}

/** Stable identity of a scenario; worlds only sync between surfaces that share it. */
export function scenarioId(scenario: Scenario): string {
  return SCENARIO_FIELDS.map((field) => `${field}:${scenario[field]}`).join('|');
}
