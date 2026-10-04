/**
 * Child of `timerLocale.ts`: runs the REAL `canonicalTimerEntryPayload` and `String.prototype.localeCompare`
 * in a process whose ICU default locale is set from the environment (`LC_ALL`), because V8 reads the
 * default locale once, when ICU starts. Reads `{ kind, cases }` on stdin, writes the results as JSON.
 */
import { readFileSync } from 'node:fs';
import { canonicalTimerEntryPayload } from '@grind/core';

const { kind, cases } = JSON.parse(readFileSync(0, 'utf8')) as { kind: 'compare' | 'canonical'; cases: any[] };
const sign = (n: number): number => (n < 0 ? -1 : n > 0 ? 1 : 0);
const out = cases.map((c) => (kind === 'compare' ? sign(String(c.a).localeCompare(c.b)) : canonicalTimerEntryPayload(c.entry)));
process.stdout.write(JSON.stringify({ locale: Intl.Collator().resolvedOptions().locale, icu: process.versions.icu, out }));
