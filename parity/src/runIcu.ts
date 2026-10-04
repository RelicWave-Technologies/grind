import { generate, serialize, fixturePath, readIfExists, writeFixture } from './fixture';
import { specs as shift } from './gen/shift';
import { specs as tz } from './gen/tz';

/**
 * Runs only the generators whose output depends on the runtime's ICU (time zones,
 * business day) and either writes them (`PARITY_FIXTURE_ROOT=/some/dir`) or
 * compares them with the committed fixtures (`--check`).
 *
 * `run.ts` loads every generator, and some of the others cannot start under
 * Electron's Node. This one can, which is the point: the legacy app runs on
 * Electron 33.2.0's ICU (74.2, tzdata 2024a), so the committed fixtures must come
 * out byte for byte the same under it as under the Node that normally dumps them.
 *
 *   ELECTRON_RUN_AS_NODE=1 <Electron 33.2.0 binary> ../node_modules/tsx/dist/cli.mjs src/runIcu.ts --check
 *
 * `--services` (or `--services-only`) adds the generators that load the real `workspaceTime.ts` / `agentConfig.ts` (plain Node only).
 */
const args = process.argv.slice(2);
const check = args.includes('--check');
const countFlag = args.indexOf('--count');
const count = countFlag === -1 ? 500 : Number(args[countFlag + 1]);

// The two that run the real services behind stubs need plain Node 22+ (module hooks for .ts stubs);
// Electron's Node 20.18 cannot load them, and neither needs ICU beyond what `tz` already covers.
const own = args.includes('--services-only') ? [] : [...tz, ...shift];
if (args.includes('--services') || args.includes('--services-only')) {
  own.push(...(await import('./gen/agentConfig')).specs, ...(await import('./gen/workspaceTime')).specs);
}

console.log(`runtime: node ${process.versions.node}, icu ${process.versions.icu}, tz ${process.versions.tz}, electron ${process.versions.electron ?? '-'}`);
let problems = 0;
for (const spec of own) {
  const path = fixturePath(spec.module, spec.fn, spec.crate);
  const text = serialize(generate(spec, count));
  if (check) {
    const onDisk = readIfExists(path);
    const state = onDisk === text ? 'same' : onDisk === null ? 'missing' : 'DIFFERENT';
    if (state !== 'same') problems++;
    console.log(`${spec.module}/${spec.fn}: ${state}`);
  } else {
    writeFixture(path, text);
    console.log(`${spec.module}/${spec.fn}: written`);
  }
}
if (problems > 0) process.exit(1);
