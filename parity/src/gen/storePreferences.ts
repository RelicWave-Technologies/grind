import type { FnSpec } from '../fixture';
import type { Rng } from '../prng';
import { enc, dec } from './jsEncoding';
import { text } from './storeValues';
import { plain, smallCount } from './seq';

const module = 'store';

/**
 * ORACLE BY COPY. `legacy/agent/src/main/services/preferences.ts` imports `electron`
 * and the logger, and `coerce` is module-private, so it cannot be imported. The
 * bodies below are copied VERBATIM from that file and run here, so the Rust is held
 * to the real logic, not to a second reading of it:
 *   Preferences / FloatingBarPreferences / DEFAULTS    preferences.ts:30-55
 *   coerce                                             preferences.ts:56-70   (comment "Merge a parsed ...")
 *   ensureLoaded (read + defaults, minus fs/log)       preferences.ts:73-86
 *   getPreferences                                     preferences.ts:88-92
 *   patchFloatingBar (minus timers/listeners)          preferences.ts:99-110
 *   rememberLastLarkTask (minus timers/listeners)      preferences.ts:117-123
 *   the file text:  JSON.stringify(cache, null, 2)     preferences.ts:`flush`
 */
interface FloatingBarPreferences {
  visible: boolean;
  x: number | null;
  y: number | null;
}
interface Preferences {
  floatingBar: FloatingBarPreferences;
  lastLarkTaskGuid: string | null;
}
const DEFAULTS: Preferences = {
  floatingBar: { visible: true, x: null, y: null },
  lastLarkTaskGuid: null,
};

function coerce(raw: unknown): Preferences {
  const r = (raw ?? {}) as Partial<Preferences>;
  const fb = (r.floatingBar ?? {}) as Partial<FloatingBarPreferences>;
  return {
    floatingBar: {
      visible: typeof fb.visible === 'boolean' ? fb.visible : DEFAULTS.floatingBar.visible,
      x: typeof fb.x === 'number' && Number.isFinite(fb.x) ? fb.x : null,
      y: typeof fb.y === 'number' && Number.isFinite(fb.y) ? fb.y : null,
    },
    lastLarkTaskGuid: typeof r.lastLarkTaskGuid === 'string' && r.lastLarkTaskGuid.length > 0
      ? r.lastLarkTaskGuid
      : null,
  };
}

/** `ensureLoaded` with the file read replaced by the text it would have read (`null` = ENOENT). */
function load(txt: string | null): Preferences {
  let cache: Preferences;
  try {
    if (txt === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    cache = coerce(JSON.parse(txt));
  } catch {
    cache = { ...DEFAULTS, floatingBar: { ...DEFAULTS.floatingBar } };
  }
  return cache;
}

function getPreferences(c: Preferences): Preferences {
  return { floatingBar: { ...c.floatingBar }, lastLarkTaskGuid: c.lastLarkTaskGuid };
}

function patchFloatingBar(c: Preferences, patch: Partial<FloatingBarPreferences>): Preferences {
  c.floatingBar = { ...c.floatingBar, ...patch };
  return getPreferences(c);
}

function rememberLastLarkTask(c: Preferences, guid: string | null): { snapshot: Preferences; changed: boolean } {
  if (c.lastLarkTaskGuid === guid) return { snapshot: getPreferences(c), changed: false };
  c.lastLarkTaskGuid = guid;
  return { snapshot: getPreferences(c), changed: true };
}

// --- the spec ----------------------------------------------------------------------

/** A JSON-safe number: finite, or one of the encodings in `jsEncoding.ts`. */
type Num = number | string | null;
type PatchIn = { visible?: boolean; x?: Num; y?: Num };
type Op = { op: 'patch'; patch: PatchIn } | { op: 'remember'; guid: string | null } | { op: 'get' };
type Input = { raw: string | null; ops: Op[] };

const decodeNum = (n: Num): number | null => (typeof n === 'string' ? dec(n) : n);
const decodePatch = (p: PatchIn): Partial<FloatingBarPreferences> => {
  const out: Partial<FloatingBarPreferences> = {};
  if (p.visible !== undefined) out.visible = p.visible;
  if (p.x !== undefined) out.x = decodeNum(p.x);
  if (p.y !== undefined) out.y = decodeNum(p.y);
  return out;
};

const pretty = (prefs: Preferences, indent = 2): string => JSON.stringify(prefs, null, indent);
const guidText = (rng: Rng): string => rng.pick(['task-abc', 'a', 'é', '😀', 'with "quotes"', 'back\\slash', 'line\nbreak', ' ', '\u007f', 'x'.repeat(40), text(rng) || 'z']);
const num = (rng: Rng): number => rng.weighted<() => number>([
  [() => rng.int(-500, 4000), 45],
  [() => rng.int(-5000, 5000) / 8, 20],
  [() => rng.pick([0, 1, -1, 0.1, 1e21, 1e-7, 123456789.123, 2 ** 53, 5e-324, 1.7976931348623157e308, 0.1 + 0.2]), 30],
  [() => rng.next() * 1e6, 5],
])();

function numToken(rng: Rng): string {
  return rng.pick(['0', '-0', '1', '12', '-5', '1.5', '1e3', '1E3', '1e-7', '2.5e+2', '123456789012345678901234567890', '0.1', '9007199254740993', '-1e21', '"1"', 'null', 'true', '[]', '{}', '""']);
}

function rawText(rng: Rng): string | null {
  const mode = rng.int(0, 14);
  const bar = (): string => {
    const parts: string[] = [];
    if (rng.chance(0.8)) parts.push(`"visible": ${rng.pick(['true', 'false', '"yes"', '1', 'null', '0'])}`);
    if (rng.chance(0.8)) parts.push(`"x": ${numToken(rng)}`);
    if (rng.chance(0.8)) parts.push(`"y": ${numToken(rng)}`);
    return `{${parts.join(', ')}}`;
  };
  const guid = (): string => rng.pick([JSON.stringify(guidText(rng)), '""', '42', 'null', 'true', '[]', '{}', '"\\u00e9\\ud83d\\ude00"', '"a\\nb"']);
  switch (mode) {
    case 0: return null;
    case 1: return pretty({ floatingBar: { visible: rng.chance(0.5), x: rng.chance(0.4) ? null : num(rng), y: rng.chance(0.4) ? null : num(rng) }, lastLarkTaskGuid: rng.chance(0.4) ? null : guidText(rng) });
    case 2: return JSON.stringify({ floatingBar: { visible: rng.chance(0.5), x: num(rng), y: num(rng) }, lastLarkTaskGuid: guidText(rng) });
    case 3: return `{"floatingBar": ${bar()}, "lastLarkTaskGuid": ${guid()}}`;
    case 4: return `{"lastLarkTaskGuid": ${guid()}}`;
    case 5: return `{"floatingBar": ${rng.pick(['null', '5', '"s"', '[]', '[1,2]', 'true', '{}'])}, "lastLarkTaskGuid": ${guid()}}`;
    case 6: return rng.pick(['', ' ', '{', '}', '{"a":', 'null', '[]', '5', '"s"', 'true', 'NaN', '{"floatingBar": {"x": NaN}}', '{"floatingBar": {"x": Infinity}}', "{'a':1}", '{"a":1,}', '[1,]', '﻿{}', '{} x', '{}{}']);
    case 7: return `\n\t  ${pretty({ floatingBar: { visible: true, x: 1, y: 2 }, lastLarkTaskGuid: 'a' })}  \n\n`;
    case 8: return `{"lastLarkTaskGuid": "first", "lastLarkTaskGuid": ${guid()}, "floatingBar": {"x": 1, "x": ${numToken(rng)}}}`;
    case 9: return `{"floatingBar": ${bar()}, "extra": {"deep": [1, 2, {"z": null}]}, "lastLarkTaskGuid": ${guid()}, "floatingBarVisible": true}`;
    case 10: return `{"floatingBar": {"visible": true, "x": ${numToken(rng)}, "y": ${numToken(rng)}}}`;
    case 11: return `{ "é": 1, "floatingBar" : { "visible" : false } , "lastLarkTaskGuid" : "日本語" }`;
    default: return JSON.stringify({ floatingBar: { visible: rng.chance(0.5), x: Math.round(num(rng)), y: Math.round(num(rng)) }, lastLarkTaskGuid: rng.chance(0.5) ? null : guidText(rng) }, null, rng.pick([0, 1, 2, 4]));
  }
}

function genOp(rng: Rng): Op {
  return rng.weighted<() => Op>([
    [() => ({ op: 'patch', patch: { x: rng.chance(0.2) ? null : enc(num(rng)), y: rng.chance(0.2) ? null : enc(num(rng)) } }), 24],
    [() => ({ op: 'patch', patch: { visible: rng.chance(0.5) } }), 12],
    [() => ({ op: 'patch', patch: { x: null, y: null } }), 8],
    [() => ({ op: 'patch', patch: { visible: rng.chance(0.5), x: enc(rng.pick([NaN, Infinity, -Infinity, -0, 5])), y: rng.chance(0.5) ? null : enc(num(rng)) } }), 8],
    [() => ({ op: 'patch', patch: {} }), 4],
    [() => ({ op: 'remember', guid: rng.chance(0.2) ? null : guidText(rng) }), 28],
    [() => ({ op: 'get' }), 10],
  ])();
}

const spec: FnSpec<Input> = {
  crate: 'timo-store',
  module,
  fn: 'preferences',
  edge: () => [
    { raw: null, ops: [] },
    { raw: null, ops: [{ op: 'remember', guid: 'task-abc' }, { op: 'remember', guid: 'task-abc' }, { op: 'patch', patch: { visible: false, x: 12, y: 34 } }, { op: 'remember', guid: null }] },
    { raw: JSON.stringify({ floatingBar: { visible: false, x: 5, y: 6 }, lastLarkTaskGuid: 42 }), ops: [{ op: 'get' }] },
    { raw: '{"floatingBar":{"visible":false,"x":5,"y":6},"lastLarkTaskGuid":"g"}', ops: [{ op: 'patch', patch: { x: 'NaN', y: 'Infinity' } }, { op: 'patch', patch: { x: '-0' } }] },
    { raw: '', ops: [] },
    { raw: '{"floatingBar":{"x":1e21,"y":-1e-7}}', ops: [{ op: 'patch', patch: {} }] },
  ],
  random: (rng) => ({ raw: rawText(rng), ops: Array.from({ length: smallCount(rng, 0, 8) }, () => genOp(rng)) }),
  call: ({ raw, ops }) => {
    const cache = load(raw);
    const initial = getPreferences(cache);
    const results = ops.map((op) => {
      if (op.op === 'patch') return { snapshot: patchFloatingBar(cache, decodePatch(op.patch)), changed: true };
      if (op.op === 'remember') return rememberLastLarkTask(cache, op.guid);
      return { snapshot: getPreferences(cache), changed: false };
    });
    return plain({ initial, results, file: pretty(cache) });
  },
};

export const specs: FnSpec<any>[] = [spec];
