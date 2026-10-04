import path from 'node:path';
import type { FnSpec } from '../fixture';
import type { Rng } from '../prng';

const module = 'winpath';

const PIECES = [
  'C:', 'c:', 'D:', 'z:', '1:', ':', '::', '\\', '\\', '\\', '/', '/', '\\\\', '//', '.', '..', '...', '.a', 'a.', 'Users', 'Anish', 'AppData', 'Local', 'Programs', 'Timo', 'timo', 'Timo.exe',
  'Old', 'Grind', '@grind', 'agent.exe', 'é', 'ß', 'İ', 'Σ', '😀', '"', ' ', 'server', 'share', 'a:b', '?', 'x', '',
];

function randomPath(rng: Rng): string {
  const n = rng.weighted([[1, 8], [2, 14], [3, 22], [5, 26], [8, 22], [12, 8]] as const);
  let out = '';
  for (let i = 0; i < n; i++) out += rng.pick(PIECES);
  return out;
}

const REALISTIC = [
  'C:\\Users\\Anish\\AppData\\Local\\Programs\\Timo\\Timo.exe',
  'c:\\users\\anish\\appdata\\local\\programs\\timo\\timo.exe',
  '"C:\\Users\\Anish\\AppData\\Local\\Programs\\Timo\\Timo.exe"',
  'C:/Users/Anish/AppData/Local/Programs/Timo/Timo.exe',
  'C:\\Users\\Anish\\AppData\\Local\\Programs\\Timo\\.\\Timo.exe',
  'C:\\Users\\Anish\\AppData\\Local\\Programs\\Timo\\..\\Timo\\Timo.exe',
  '\\\\server\\share\\dir\\file.exe', '\\\\server\\share', '\\\\server\\share\\', '\\\\server', '\\\\', '\\', '/', '', '.', '..', 'C:', 'C:\\', 'C:.', 'C:..\\a', 'C:a\\b', 'a:b', 'a\\b:c', 'a\\:b',
];

/**
 * Node 22.23 (the harness) treats `\\\\?\\` and `\\\\.\\` as device roots and knows reserved
 * device names (a 2025 change); Electron 33's Node 20.18, which the legacy agent
 * ran, does not, and the port follows the older algorithm. Inputs that start with
 * a device root are left out so the fixtures only record behaviour both agree on.
 */
const DEVICE_ROOT = /^[\\/]{2}[.?](?:[\\/]|$)/;

const pathAny = (rng: Rng): string => {
  for (;;) {
    const candidate = rng.chance(0.3) ? rng.pick(REALISTIC) : randomPath(rng);
    if (!DEVICE_ROOT.test(candidate)) return candidate;
  }
};

function unary(fn: string, call: (p: string) => string): FnSpec<{ path: string }> {
  return {
    module,
    fn,
    edge: () => REALISTIC.map((p) => ({ path: p })),
    random: (rng) => ({ path: pathAny(rng) }),
    call: ({ path: p }) => call(p),
  };
}

const joinSpec: FnSpec<{ paths: string[] }> = {
  module,
  fn: 'join',
  edge: () => [
    { paths: [] }, { paths: [''] }, { paths: ['C:\\Users\\Anish\\AppData\\Local\\Programs', 'Grind', 'Grind.exe'] }, { paths: ['\\\\server', 'share'] }, { paths: ['//server', 'share'] },
    { paths: ['///a', 'b'] }, { paths: ['a', '', 'b'] }, { paths: ['', '', ''] }, { paths: ['C:', 'x'] }, { paths: ['C:\\a', '..', '..', '..', 'b'] },
  ],
  random: (rng) => {
    for (;;) {
      const paths = Array.from({ length: rng.int(1, 4) }, () => (rng.chance(0.15) ? '' : pathAny(rng)));
      // join glues the parts with a backslash, which can itself form a device root.
      if (!DEVICE_ROOT.test(paths.filter((p) => p.length > 0).join('\\'))) return { paths };
    }
  },
  call: ({ paths }) => path.win32.join(...paths),
};

const LOWER = ['TIMO', 'Timo Time Tracker', 'İSTANBUL', 'ΣΊΣΥΦΟΣ', 'Σ', 'ΑΣ', 'A\u03a3', 'ǅ', 'ß', 'ẞ', 'ﬃ', 'Ⅻ', 'C:\\USERS\\ÀÉÎ', '😀', 'ŉ', 'I\u0307', 'İ', 'ὈΔΥΣΣΕΎΣ', 'Ꭰ'];
const lowerSpec: FnSpec<{ text: string }> = {
  module,
  fn: 'toLowerCase',
  edge: () => LOWER.map((text) => ({ text })),
  random: (rng) => ({ text: Array.from({ length: rng.int(1, 6) }, () => rng.pick(LOWER)).join(rng.pick(['', ' ', '\\'])) }),
  call: ({ text }) => text.toLowerCase(),
};

export const specs: FnSpec<any>[] = [
  unary('normalize', (p) => path.win32.normalize(p)),
  unary('basename', (p) => path.win32.basename(p)),
  unary('dirname', (p) => path.win32.dirname(p)),
  joinSpec,
  lowerSpec,
];
