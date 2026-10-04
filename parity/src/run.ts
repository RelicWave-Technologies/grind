import { generate, serialize, fixturePath, fixtureRoot, listFixtures, readIfExists, writeFixture, type FixtureCrate, type FnSpec } from './fixture';
import { specs as segments } from './gen/segments';
import { specs as clamp } from './gen/clamp';
import { specs as timerLedger } from './gen/timerLedger';
import { specs as timerLocale } from './gen/timerLocale';
import { specs as todayLedger } from './gen/todayLedger';
import { specs as js } from './gen/js';
import { specs as activity } from './gen/activity';
import { specs as osCrypt } from './gen/osCrypt';
import { specs as idle } from './gen/idle';
import { specs as attention } from './gen/attention';
import { specs as shift } from './gen/shift';
import { specs as tz } from './gen/tz';
import { specs as store } from './gen/store';
import { specs as timerScenarios } from './scenarios/timer';
import { specs as capture } from './gen/capture';
import { specs as syncActivity } from './gen/syncActivity';
import { specs as syncAuth } from './gen/syncAuth';
import { specs as syncUploader } from './gen/syncUploader';
import { specs as syncWire } from './gen/syncWire';
import { specs as desktopSmall } from './gen/desktopSmall';
import { specs as updates } from './gen/updates';
import { specs as agentConfig } from './gen/agentConfig';
import { specs as workspaceTime } from './gen/workspaceTime';
import { specs as readiness } from './gen/readiness';
import { specs as quit } from './gen/quit';
import { compatFiles } from './scenarios/timerCompat';
import { specs as winPath } from './gen/winPath';
import { specs as launch } from './gen/launch';
import { specs as jsMath } from './gen/jsMath';
import { relative } from 'node:path';
import { rmSync } from 'node:fs';

/**
 * Regenerates every golden fixture from the real TypeScript.
 *
 *   tsx src/run.ts            write the fixtures
 *   tsx src/run.ts --check    generate in memory; exit 1 if any file on disk differs
 *                             (also catches missing and stale files, which
 *                             `git diff` cannot see while they are untracked)
 *   --count N                 random cases per function (default 500)
 *   --only substring          only functions whose "module/fn" contains it
 */
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const check = args.includes('--check');
const count = Number(flag('--count') ?? 500);
const only = flag('--only');

const all: FnSpec<any>[] = [...segments, ...clamp, ...timerLedger, ...timerLocale, ...todayLedger, ...js, ...activity, ...idle, ...attention, ...osCrypt, ...tz, ...shift, ...workspaceTime, ...agentConfig, ...store, ...timerScenarios, ...capture, ...syncActivity, ...syncAuth, ...syncUploader, ...syncWire, ...desktopSmall, ...updates, ...readiness, ...quit, ...winPath, ...launch, ...jsMath];
const wanted = all.filter((s) => !only || `${s.module}/${s.fn}`.includes(only));

const expected = new Map<string, string>();
for (const spec of wanted) {
  const fixture = generate(spec, count);
  expected.set(fixturePath(spec.module, spec.fn, spec.crate), serialize(fixture));
  console.log(`${spec.module}/${spec.fn}: ${fixture.cases.length} cases (${fixture.cases.filter((c) => typeof c.output === 'object' && c.output !== null && 'error' in c.output).length} errors, ${fixture.skipped} zone-dependent skipped)`);
}

// timer/compat: a real agent.db written by the legacy store (not a per-function fixture).
if (!only || 'timer/compat'.includes(only)) for (const [path, text] of compatFiles()) expected.set(path, text);

const CRATES: FixtureCrate[] = ['timo-core', 'timo-sync', 'timo-store'];
/** Every fixture file on disk that nothing generates any more, as absolute paths. */
function staleFiles(): string[] {
  const known = new Set(expected.keys());
  return CRATES.flatMap((c) => listFixtures(c).map((f) => `${fixtureRoot(c)}/${f}`)).filter((p) => !known.has(p));
}
const labelOf = (path: string): string => {
  const root = CRATES.map((c) => fixtureRoot(c)).find((r) => path.startsWith(`${r}/`));
  return root ? (root === fixtureRoot('timo-core') ? relative(root, path) : `${relative(`${root}/../..`, root)}/${relative(root, path)}`) : path;
};

if (check) {
  const problems: string[] = [];
  for (const [path, text] of expected) {
    const onDisk = readIfExists(path);
    if (onDisk === null) problems.push(`missing  ${labelOf(path)}`);
    else if (onDisk !== text) problems.push(`changed  ${labelOf(path)}`);
  }
  if (!only) for (const path of staleFiles()) problems.push(`stale    ${labelOf(path)}`);
  if (problems.length > 0) {
    console.error(`parity fixtures out of date:\n${problems.join('\n')}`);
    process.exit(1);
  }
  console.log('parity fixtures are up to date');
} else {
  if (!only) for (const path of staleFiles()) rmSync(path);
  for (const [path, text] of expected) writeFixture(path, text);
}
