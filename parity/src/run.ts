import { generate, serialize, fixturePath, listFixtures, readIfExists, writeFixture, FIXTURE_ROOT, type FnSpec } from './fixture';
import { specs as segments } from './gen/segments';
import { specs as clamp } from './gen/clamp';
import { specs as timerLedger } from './gen/timerLedger';
import { specs as todayLedger } from './gen/todayLedger';
import { specs as js } from './gen/js';
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

const all: FnSpec<any>[] = [...segments, ...clamp, ...timerLedger, ...todayLedger, ...js];
const wanted = all.filter((s) => !only || `${s.module}/${s.fn}`.includes(only));

const expected = new Map<string, string>();
for (const spec of wanted) {
  const fixture = generate(spec, count);
  expected.set(fixturePath(spec.module, spec.fn), serialize(fixture));
  console.log(`${spec.module}/${spec.fn}: ${fixture.cases.length} cases (${fixture.cases.filter((c) => typeof c.output === 'object' && c.output !== null && 'error' in c.output).length} errors, ${fixture.skipped} zone-dependent skipped)`);
}

if (check) {
  const problems: string[] = [];
  for (const [path, text] of expected) {
    const onDisk = readIfExists(path);
    if (onDisk === null) problems.push(`missing  ${relative(FIXTURE_ROOT, path)}`);
    else if (onDisk !== text) problems.push(`changed  ${relative(FIXTURE_ROOT, path)}`);
  }
  if (!only) {
    const known = new Set([...expected.keys()].map((p) => relative(FIXTURE_ROOT, p)));
    for (const file of listFixtures()) if (!known.has(file)) problems.push(`stale    ${file}`);
  }
  if (problems.length > 0) {
    console.error(`parity fixtures out of date:\n${problems.join('\n')}`);
    process.exit(1);
  }
  console.log('parity fixtures are up to date');
} else {
  if (!only) {
    const known = new Set([...expected.keys()].map((p) => relative(FIXTURE_ROOT, p)));
    for (const file of listFixtures()) if (!known.has(file)) rmSync(`${FIXTURE_ROOT}/${file}`);
  }
  for (const [path, text] of expected) writeFixture(path, text);
}
