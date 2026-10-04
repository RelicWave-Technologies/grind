import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Rng, seedFor } from '../prng';
import type { FnSpec } from '../fixture';
import { edgeScenarios } from './timerEdge';
import { burstScenarios } from './timerBursts';
import { failureScenarios } from './timerFailures';
import { historyScenarios } from './timerHistory';
import { randomScenario } from './timerGen';
import type { Scenario, StepRecord } from './timerTypes';

/**
 * Differential scenarios for the timer engine: the REAL legacy `TimerService`,
 * `SqliteEntryStore`, `SqliteTodayLedgerStore`, `HttpSyncClient` and server clock
 * run an op sequence on `:memory:` better-sqlite3 under a scripted machine, and the
 * state after EVERY op is recorded. Fixtures go to
 * `crates/timo-store/tests/fixtures/timer/scenarios.json`, which the Rust test
 * replays byte for byte.
 *
 * The scenarios run in one child process (`timerChild.ts`): they patch
 * `Date.now`, and the generators of other modules evaluate concurrently with this
 * one. Inputs are generated here from the seed the recorder derives
 * (`seedFor('timer/scenarios') ^ PARITY_SALT`) and handed out in order, like
 * `asyncSpec` does.
 */
const args = process.argv.slice(2);
const countFlag = args.indexOf('--count');
const COUNT = countFlag === -1 ? 500 : Number(args[countFlag + 1]);
const SALT = Number(process.env.PARITY_SALT ?? 0);

function runAll(scenarios: Scenario[]): StepRecord[][] {
  const child = fileURLToPath(new URL('./timerChild.ts', import.meta.url));
  const run = spawnSync(process.execPath, ['--import', 'tsx', child], {
    input: JSON.stringify(scenarios),
    encoding: 'utf8',
    maxBuffer: 1 << 30,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  if (run.status !== 0) throw new Error(`timer scenario child failed (status ${run.status}, signal ${run.signal})`);
  return JSON.parse(run.stdout) as StepRecord[][];
}

const rng = new Rng((seedFor('timer/scenarios') ^ SALT) >>> 0);
const edges = [...edgeScenarios(), ...historyScenarios(), ...failureScenarios(), ...burstScenarios()];
const randoms: Scenario[] = [];
for (let i = 1; i <= COUNT; i++) randoms.push(randomScenario(rng, i));
const all = [...edges, ...randoms];
const outputs = runAll(all);
const results = new Map<Scenario, StepRecord[]>(all.map((scenario, i) => [scenario, outputs[i]!]));
let next = 0;

const spec: FnSpec<Scenario> = {
  crate: 'timo-store',
  module: 'timer',
  fn: 'scenarios',
  edge: () => {
    next = 0;
    return edges;
  },
  random: () => {
    const input = randoms[next++];
    if (input === undefined) throw new Error('timer/scenarios: more random cases requested than precomputed');
    return input;
  },
  call: (input) => {
    const out = results.get(input);
    if (out === undefined) throw new Error('timer/scenarios: no precomputed result for this input');
    return out;
  },
};

export const specs: FnSpec<any>[] = [spec];
