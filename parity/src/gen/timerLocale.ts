import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { FnSpec } from '../fixture';
import { Rng, seedFor } from '../prng';

/**
 * `localeCompare` follows the ICU DEFAULT locale of the process, and `canonicalTimerEntryPayload` sorts
 * segments that tie on `startedAt` with it. On Electron 33.2.0 that default comes from the environment
 * (`LC_ALL`, else `LC_MESSAGES`, else `LANG`; nothing set means en-US) and NOT from `app.getLocale()` or the
 * macOS preferred languages, measured on the real binary (crates/timo-core/PARITY.md, "Locale").
 *
 * So the same two ULIDs compare -1 under en-US and +1 under cs-CZ (the Czech "ch" is one letter after "h").
 * These fixtures run the real functions in one child process per locale, with that locale's environment,
 * over ids chosen to hit the tailorings (digraphs, `aa`, `y`/`z`/`v`/`w` placements, accented letters), and
 * the Rust test compares each result under `collator_for(locale)`.
 */
const SALT = Number(process.env.PARITY_SALT ?? 0);
const countFlag = process.argv.indexOf('--count');
const COUNT = countFlag === -1 ? 500 : Number(process.argv[countFlag + 1]);

/*
 * Not listed: the languages Node 22's ICU (78.2, CLDR 48) tailors but Electron 33.2.0's trimmed ICU (74.2,
 * CLDR 44.1) collates as the root does (haw, nn, cy, is, sq, az, bs, mt, ...): a Node-generated fixture would
 * assert what the oracle does not do. Those are covered by the Electron snapshot instead
 * (`electronLocale.mjs`, tests/data/locale_electron.json). Every locale below agrees between the two:
 * `PARITY_LOCALE_RUNTIME=<Electron> PARITY_FIXTURE_ROOT=/tmp/x tsx src/run.ts --only locale/` is byte-identical.
 */
/** Locales with a tailoring that touches ASCII or common Latin, plus ones that do not (to prove they stay root). */
export const LOCALES = [
  'en-US', 'cs-CZ', 'sk-SK', 'hu-HU', 'da-DK', 'nb-NO', 'lt-LT', 'et-EE', 'hr-HR', 'sl-SI',
  'sv-SE', 'fi-FI', 'tr-TR', 'pl-PL', 'es-ES', 'de-DE', 'fr-FR', 'vi-VN', 'lv-LV', 'ro-RO', 'ca-ES',
  'el-GR', 'ru-RU', 'uk-UA', 'bg-BG', 'ja-JP', 'ko-KR', 'zh-CN', 'th-TH', 'ar-SA', 'he-IL', 'hi-IN',
  'fil-PH', 'ga-IE', 'nl-NL', 'pt-PT', 'it-IT', 'ms-MY', 'sr-RS', 'mk-MK', 'be-BY',
];

const RUNTIME = process.env.PARITY_LOCALE_RUNTIME;
const posix = (tag: string): string => `${tag.replace('-', '_')}.UTF-8`;

const PAIRS: Array<[string, string]> = [
  ['01ARZ3NDEKTSV4RRFFQ69G50CH', '01ARZ3NDEKTSV4RRFFQ69G50CJ'], ['CH', 'D'], ['CH', 'CZ'], ['H', 'CH'], ['CI', 'CH'], ['DZ', 'E'], ['DZ', 'DS'], ['DS', 'DZ'],
  ['DZS', 'DZ'], ['SZ', 'T'], ['SZ', 'SA'], ['ZS', 'Z'], ['ZS', 'ZA'], ['GY', 'H'], ['GY', 'GZ'], ['NY', 'O'], ['TY', 'U'], ['TY', 'TZ'],
  ['CS', 'D'], ['CS', 'CT'], ['LY', 'M'], ['AA', 'AZ'], ['AA', 'B'], ['AA', 'Z'], ['ZA', 'AA'], ['LL', 'LM'], ['LL', 'M'], ['LJ', 'LK'],
  ['NJ', 'NK'], ['NG', 'NH'], ['NG', 'O'], ['PH', 'PI'], ['PH', 'Q'], ['RH', 'RI'], ['TH', 'TI'], ['TH', 'U'], ['FF', 'FG'], ['DD', 'DE'],
  ['Y', 'Z'], ['Y', 'J'], ['Y', 'X'], ['Z', 'T'], ['Z', 'S'], ['Z', 'ZZ'], ['V', 'W'], ['W', 'X'], ['W', 'V'], ['I', 'J'], ['A', 'B'],
  ['Å', 'Z'], ['Å', 'A'], ['Ä', 'Z'], ['Ä', 'A'], ['Ö', 'Z'], ['Ö', 'O'], ['Ü', 'V'], ['Ü', 'U'], ['Ø', 'Z'], ['Æ', 'Z'], ['Ç', 'D'], ['Ç', 'C'],
  ['Ñ', 'O'], ['Ñ', 'N'], ['é', 'f'], ['ß', 'ss'], ['a', 'B'], ['a', 'A'], ['seg_a', 'seg_b'], ['ID00000001', 'ID00000002'], ['ID00000010', 'ID00000009'],
  ['ch', 'h'], ['Ch', 'cH'], ['dz', 'dZ'], ['ll', 'lm'], ['aa', 'az'], ['IJ', 'IK'], ['Ğ', 'H'], ['İ', 'J'], ['ı', 'I'], ['Š', 'T'], ['Č', 'D'],
  ['Ž', 'ZZ'], ['Ł', 'M'], ['Đ', 'E'], ['ǅ', 'E'], ['ǆ', 'D'], ['á', 'b'], ['', 'A'], ['A', ''],
];

const LETTERS = 'CHDZSGYNTLPRFAVWXJKBEMQ0123456789';
const pickWord = (rng: Rng): string => {
  const length = rng.int(1, 8);
  let word = '';
  for (let i = 0; i < length; i++) word += rng.chance(0.15) ? rng.pick(['Å', 'Ä', 'Ö', 'Ü', 'é', 'Č', 'Š', 'Ł', 'ñ', 'ç', 'a', 'h']) : LETTERS[rng.int(0, LETTERS.length - 1)]!;
  return word;
};
const pairOf = (rng: Rng): { a: string; b: string } => {
  const a = pickWord(rng);
  if (rng.chance(0.55)) return { a: `${a}${rng.pick(['CH', 'DZ', 'SZ', 'ZS', 'GY', 'AA', 'LL', 'NG', 'TH', 'CJ', 'Y', 'Z'])}`, b: `${a}${pickWord(rng)}` };
  return { a, b: pickWord(rng) };
};

type PairInput = { locale: string; a: string; b: string };
type EntryInput = { locale: string; entry: Record<string, unknown> };

function entryOf(rng: Rng, locale: string): EntryInput {
  const base = 1_700_000_000_000 + rng.int(0, 1_000_000) * 7;
  const count = rng.int(2, 6);
  const segments = Array.from({ length: count }, () => {
    const start = rng.chance(0.75) ? base : base + rng.pick([1, 1000, 5]);
    return { id: rng.chance(0.5) ? pickWord(rng) : rng.pick(PAIRS)[rng.int(0, 1)]!, kind: rng.pick(['WORK', 'MEETING', 'IDLE_TRIMMED']), startedAt: start, endedAt: rng.chance(0.3) ? null : start + 60_000 };
  });
  return { locale, entry: { id: 'entry', clientUuid: 'client', larkTaskGuid: null, source: 'AUTO', revision: 3, startedAt: base, endedAt: null, closeReason: null, segments } };
}

/** Runs `inputs` in one child process per locale and returns the outputs in the inputs' order. */
function runPerLocale<I extends { locale: string }>(kind: 'compare' | 'canonical', inputs: I[]): Map<I, unknown> {
  const child = fileURLToPath(new URL('./timerLocaleChild.ts', import.meta.url));
  const results = new Map<I, unknown>();
  for (const locale of new Set(inputs.map((i) => i.locale))) {
    const mine = inputs.filter((i) => i.locale === locale);
    const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: posix(locale), LANG: posix(locale) };
    delete env.LC_MESSAGES;
    // `PARITY_LOCALE_RUNTIME=<Electron 33.2.0 binary>` runs the children under Electron's own ICU (74.2,
    // CLDR 44.1), the oracle; the default, Node's ICU, must agree on every locale listed in LOCALES.
    if (RUNTIME) env.ELECTRON_RUN_AS_NODE = '1';
    const run = spawnSync(RUNTIME ?? process.execPath, ['--import', 'tsx', child], { input: JSON.stringify({ kind, cases: mine }), encoding: 'utf8', env, maxBuffer: 1 << 28, stdio: ['pipe', 'pipe', 'inherit'] });
    if (run.status !== 0) throw new Error(`locale child ${locale} failed (status ${run.status})`);
    const parsed = JSON.parse(run.stdout) as { locale: string; out: unknown[] };
    // The child must really have run under the locale asked for (V8 maps an unknown one to en-US).
    if (!parsed.locale.startsWith(locale.split('-')[0]!) ) console.error(`note: ${locale} ran as ${parsed.locale}`);
    mine.forEach((input, i) => results.set(input, parsed.out[i]));
  }
  return results;
}

function spec<I extends { locale: string }>(fn: string, kind: 'compare' | 'canonical', edge: () => I[], random: (rng: Rng) => I): FnSpec<I> {
  const rng = new Rng((seedFor(`locale/${fn}`) ^ SALT) >>> 0);
  const edges = edge();
  const randoms = Array.from({ length: COUNT }, () => random(rng));
  // One child process per locale: only when this spec is actually generated.
  let results: Map<I, unknown> | null = null;
  let next = 0;
  return {
    module: 'locale',
    fn,
    edge: () => { next = 0; return edges; },
    random: () => { const input = randoms[next++]; if (input === undefined) throw new Error(`locale/${fn}: more cases requested than precomputed`); return input; },
    call: (input) => (results ??= runPerLocale(kind, [...edges, ...randoms])).get(input),
  };
}

export const specs: FnSpec<any>[] = [
  spec<PairInput>('localeCompareIn', 'compare', () => LOCALES.flatMap((locale) => PAIRS.map(([a, b]) => ({ locale, a, b }))), (rng) => ({ locale: rng.pick(LOCALES), ...pairOf(rng) })),
  spec<EntryInput>('canonicalPayloadIn', 'canonical', () => LOCALES.map((locale) => entryOf(new Rng(1), locale)), (rng) => entryOf(rng, rng.pick(LOCALES))),
];
