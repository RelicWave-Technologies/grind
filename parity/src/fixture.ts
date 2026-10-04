import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Rng, seedFor } from './prng';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_ROOT = process.env.PARITY_FIXTURE_ROOT ?? join(here, '..', '..', 'crates', 'timo-core', 'tests', 'fixtures');
/** XORed into every seed: `PARITY_SALT=7` explores different random cases (never committed). */
const SALT = Number(process.env.PARITY_SALT ?? 0);

/** One generated case: the input handed to the function and what it produced. */
export interface Case {
  input: unknown;
  output: unknown;
}

/**
 * A function under test. `edge` are hand-picked inputs; `random` makes one
 * seeded adversarial input. `call` runs the real TypeScript. Thrown errors
 * become `{ error: message }`.
 */
export interface FnSpec<I> {
  module: string;
  fn: string;
  edge: () => I[];
  random: (rng: Rng) => I;
  call: (input: I) => unknown;
  /** Optional: the value recorded as `input` (defaults to the input itself). */
  record?: (input: I) => unknown;
  /** Skip the finite-number guard (helpers whose inputs are NaN/Infinity). */
  allowNonFinite?: boolean;
  /** Optional: how the output is recorded (defaults to as is). */
  encodeOutput?: (output: unknown) => unknown;
}

export interface Fixture {
  fn: string;
  seed: number;
  cases: Case[];
}

/** Inputs must survive JSON and the Rust i64 domain; fail loudly otherwise. */
export function assertPlain(value: unknown, where: string, allowNonFinite: boolean, side: 'input' | 'output' = 'input'): void {
  if (typeof value === 'number') {
    if (Object.is(value, -0)) throw new Error(`${where}: -0 cannot be recorded`);
    if (!Number.isFinite(value)) {
      if (!allowNonFinite && side === 'input') throw new Error(`${where}: non-finite number ${value}`);
      return;
    }
    // Timestamps are fractional doubles, so any finite number is a valid input.
    // Outputs may be non-finite (a sum that overflowed): JSON.stringify writes
    // `null` and so does the Rust serializer.
    return;
  }
  if (value === undefined) throw new Error(`${where}: undefined`);
  if (Array.isArray(value)) value.forEach((v, i) => assertPlain(v, `${where}[${i}]`, allowNonFinite, side));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertPlain(v, `${where}.${k}`, allowNonFinite, side);
  }
}

/** Lone surrogates do not survive JSON.stringify -> serde; refuse them. */
function assertWellFormed(text: string, where: string): void {
  const withoutPairs = text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '');
  if (/[\uD800-\uDFFF]/.test(withoutPairs)) throw new Error(`${where}: lone surrogate in generated string`);
}

/**
 * Time zones every case is run under. A case whose output changes with the
 * machine's zone read local time (V8's legacy date parser does, for strings
 * without an offset), which a pure port cannot reproduce; such cases are left
 * out of the fixtures rather than recorded for whichever zone ran the dump.
 */
const ZONES = ['UTC', 'Asia/Kolkata', 'America/New_York', 'Australia/Lord_Howe', 'Pacific/Apia'];

export interface Generated extends Fixture {
  skipped: number;
}

export function generate<I>(spec: FnSpec<I>, count: number): Generated {
  const seed = (seedFor(`${spec.module}/${spec.fn}`) ^ SALT) >>> 0;
  const rng = new Rng(seed);
  const cases: Case[] = [];
  let skipped = 0;
  const take = (input: I, index: number): boolean => {
    const c = runCase(spec, input, index);
    if (c === null) skipped++;
    else cases.push(c);
    return c !== null;
  };
  spec.edge().forEach((input, index) => take(input, index));
  let made = 0;
  for (let attempts = 0; made < count && attempts < count * 4; attempts++) {
    if (take(spec.random(rng), cases.length)) made++;
  }
  if (made < count) throw new Error(`${spec.module}/${spec.fn}: too many zone-dependent cases`);
  return { fn: spec.fn, seed, cases, skipped };
}

function callOnce<I>(spec: FnSpec<I>, input: I): unknown {
  let output: unknown;
  try {
    output = spec.call(input);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    output = { error: error.message };
  }
  if (output === undefined) output = null;
  if (spec.encodeOutput && !(typeof output === 'object' && output !== null && 'error' in output)) {
    output = spec.encodeOutput(output);
  }
  return output;
}

function runCase<I>(spec: FnSpec<I>, input: I, index: number): Case | null {
  const where = `${spec.module}/${spec.fn}#${index}`;
  const recorded = spec.record ? spec.record(input) : input;
  assertPlain(recorded, `${where}.input`, spec.allowNonFinite ?? false);
  const before = JSON.stringify(recorded);
  assertWellFormed(before, `${where}.input`);
  const original = process.env.TZ;
  let output: unknown;
  try {
    const texts = new Set<string>();
    for (const zone of ZONES) {
      process.env.TZ = zone;
      output = callOnce(spec, input);
      texts.add(JSON.stringify(output));
    }
    if (texts.size > 1) return null;
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
  assertPlain(output, `${where}.output`, spec.allowNonFinite ?? false, 'output');
  if (JSON.stringify(spec.record ? spec.record(input) : input) !== before) {
    throw new Error(`${where}: the function mutated its input`);
  }
  assertWellFormed(JSON.stringify(output), `${where}.output`);
  return { input: recorded, output };
}

/** Pretty at the top, one compact case per line: diffable and still small. */
export function serialize(fixture: Fixture): string {
  const lines = fixture.cases.map((c) => `    ${JSON.stringify({ input: c.input, output: c.output })}`);
  return [
    '{',
    `  "fn": ${JSON.stringify(fixture.fn)},`,
    `  "seed": ${fixture.seed},`,
    '  "cases": [',
    lines.join(',\n'),
    '  ]',
    '}',
    '',
  ].join('\n');
}

export function fixturePath(module: string, fn: string): string {
  return join(FIXTURE_ROOT, module, `${snake(fn)}.json`);
}

/** camelCase to snake_case, the Rust spelling of the function name. */
export function snake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

export function writeFixture(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** Every `.json` fixture currently on disk, as paths relative to the root. */
export function listFixtures(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.json')) found.push(relative(FIXTURE_ROOT, full));
    }
  };
  walk(FIXTURE_ROOT);
  return found.sort();
}
