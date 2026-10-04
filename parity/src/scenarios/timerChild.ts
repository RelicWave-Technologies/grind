/**
 * Child process entry point of the timer scenarios: reads a JSON array of
 * scenarios from stdin, runs each against the real legacy timer, and writes the
 * step records as one JSON array to stdout.
 *
 * It is a separate process because the legacy code reads `Date.now()` and the
 * server clock's module state, which a scenario patches globally. Run inside the
 * fixture generator, those patches would be visible to (and clobbered by) the
 * other generators' asynchronous scenarios, which evaluate concurrently.
 */
import { readFileSync } from 'node:fs';
import type { Scenario } from './timerTypes';

if (process.argv[2] === 'compat') {
  const { buildCompat } = await import('./timerCompatBuild');
  process.stdout.write(buildCompat());
} else {
  const { runScenario } = await import('./timerRun');
  const scenarios = JSON.parse(readFileSync(0, 'utf8')) as Scenario[];
  const results: unknown[] = [];
  for (const scenario of scenarios) results.push(await runScenario(scenario));
  process.stdout.write(JSON.stringify(results));
}
