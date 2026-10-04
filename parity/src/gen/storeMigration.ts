import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FnSpec } from '../fixture';
import type { Rng } from '../prng';
import { smallCount } from './seq';

const module = 'store';

/**
 * ORACLE BY COPY. `legacy/agent/src/main/services/legacyMigration.ts` imports `electron`
 * and the logger, so it cannot be imported. `migrateLegacyUserData` and
 * `quarantineLegacyEntry` below are copied VERBATIM from that file (lines 6-9 for the
 * constants, 21-49 and 51-59 for the functions); the only edits are that
 * `app.getPath('userData')` is the `currentDir` parameter and `log.*` is a no-op.
 * They run against a real temporary directory and the resulting tree is the output.
 */
const LEGACY_APP_DIRS = ['Grind', path.join('@grind', 'agent')];
const MIGRATE_ENTRIES = ['tokens.bin', 'pending-lark-login.bin', 'agent.db', 'preferences.json', 'screenshots'];
const MIGRATED_SUFFIX = '.migrated-to-timo';
const log = { info: (..._a: unknown[]): void => undefined, warn: (..._a: unknown[]): void => undefined };

function migrateLegacyUserData(currentDirParam: string): void {
  try {
    const currentDir = currentDirParam;
    if (fs.existsSync(path.join(currentDir, 'tokens.bin'))) return; // already signed in here
    const parent = path.dirname(currentDir);
    for (const name of LEGACY_APP_DIRS) {
      const legacyDir = path.join(parent, name);
      if (legacyDir === currentDir || !fs.existsSync(path.join(legacyDir, 'tokens.bin'))) continue;
      fs.mkdirSync(currentDir, { recursive: true });
      for (const entry of MIGRATE_ENTRIES) {
        const from = path.join(legacyDir, entry);
        const to = path.join(currentDir, entry);
        if (fs.existsSync(from) && !fs.existsSync(to)) {
          fs.cpSync(from, to, { recursive: true });
          quarantineLegacyEntry(from);
        }
      }
      log.info('migrated legacy session from prior app identity', { from: legacyDir, to: currentDir });
      return;
    }
  } catch (err) {
    log.warn('legacy userData migration failed', { err: String(err) });
  }
}

function quarantineLegacyEntry(file: string): void {
  try {
    const backup = `${file}${MIGRATED_SUFFIX}`;
    if (fs.existsSync(backup)) fs.rmSync(file, { force: true });
    else fs.renameSync(file, backup);
  } catch (err) {
    log.warn('legacy userData quarantine failed', { file, err: String(err) });
  }
}

/** The tree to build under a fresh root: relative path -> file text, or `null` for an (empty) directory. */
type Input = { tree: Record<string, string | null> };

const CURRENT = 'Timo';
const LEGACY = ['Grind', '@grind/agent'];
const ENTRIES = ['tokens.bin', 'pending-lark-login.bin', 'agent.db', 'preferences.json', 'screenshots'];
const CONTENTS = ['TOKENS', 'PENDING', 'DB', '{"floatingBarVisible":true}', 'JPEG', '', 'é 😀\n', 'x'.repeat(2000)];

function build(root: string, tree: Record<string, string | null>): void {
  for (const [rel, content] of Object.entries(tree)) {
    const full = path.join(root, rel);
    if (content === null) fs.mkdirSync(full, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }
}

/** Every file and directory under `root`, sorted: `[relative path, 'f' | 'd', text]`. */
function dumpTree(root: string): [string, string, string | null][] {
  const out: [string, string, string | null][] = [];
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (fs.statSync(full).isDirectory()) {
        out.push([rel, 'd', null]);
        walk(full);
      } else out.push([rel, 'f', fs.readFileSync(full, 'utf8')]);
    }
  };
  walk(root);
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function genLegacyDir(rng: Rng, dir: string, tree: Record<string, string | null>): void {
  tree[dir] = null;
  if (rng.chance(0.8)) tree[`${dir}/tokens.bin`] = rng.pick(CONTENTS);
  for (const entry of ENTRIES.slice(1)) {
    if (!rng.chance(0.55)) continue;
    if (entry === 'screenshots') {
      tree[`${dir}/screenshots`] = null;
      for (let i = 0; i < smallCount(rng, 0, 3); i++) tree[`${dir}/screenshots/2026-01-0${i + 1}/shot${i}.jpg`] = rng.pick(CONTENTS);
    } else tree[`${dir}/${entry}`] = rng.pick(CONTENTS);
  }
  // A previous run left some entries quarantined already.
  for (const entry of ENTRIES) {
    if (!rng.chance(0.15)) continue;
    if (entry === 'screenshots' && rng.chance(0.5)) {
      tree[`${dir}/${entry}${MIGRATED_SUFFIX}`] = null;
      tree[`${dir}/${entry}${MIGRATED_SUFFIX}/old.jpg`] = 'OLD';
    } else tree[`${dir}/${entry}${MIGRATED_SUFFIX}`] = 'OLD-BACKUP';
  }
}

function genTree(rng: Rng): Record<string, string | null> {
  const tree: Record<string, string | null> = {};
  for (const dir of LEGACY) if (rng.chance(0.6)) genLegacyDir(rng, dir, tree);
  if (rng.chance(0.5)) {
    tree[CURRENT] = null;
    if (rng.chance(0.2)) tree[`${CURRENT}/tokens.bin`] = 'CURRENT';
    for (const entry of ENTRIES.slice(1)) {
      if (!rng.chance(0.2)) continue;
      if (entry === 'screenshots') {
        tree[`${CURRENT}/screenshots/keep`] = null;
        tree[`${CURRENT}/screenshots/keep.jpg`] = 'KEEP';
      } else tree[`${CURRENT}/${entry}`] = 'KEEP';
    }
  }
  if (rng.chance(0.1)) tree['Other/tokens.bin'] = 'NOT-A-LEGACY-DIR';
  return tree;
}

const spec: FnSpec<Input> = {
  crate: 'timo-store',
  module,
  fn: 'legacyMigration',
  edge: (): Input[] => [
    { tree: {} },
    { tree: { 'Grind/tokens.bin': 'TOKENS', 'Grind/pending-lark-login.bin': 'PENDING' } },
    { tree: { '@grind/agent/tokens.bin': 'TOKENS', '@grind/agent/agent.db': 'DB', '@grind/agent/preferences.json': '{"floatingBarVisible":true}', '@grind/agent/screenshots/shot.jpg': 'JPEG' } },
    { tree: { 'Grind/tokens.bin': 'OLD', 'Timo/tokens.bin': 'CURRENT' } },
    { tree: { Timo: null } },
    { tree: { 'Grind/tokens.bin': 'A', 'Grind/screenshots/s.jpg': 'S', 'Grind/screenshots.migrated-to-timo/old.jpg': 'OLD' } },
    { tree: { 'Grind/tokens.bin': 'A', 'Grind/tokens.bin.migrated-to-timo': 'B', 'Grind/agent.db': 'DB', 'Grind/agent.db.migrated-to-timo': 'OLDDB' } },
    { tree: { 'Grind/tokens.bin': 'G', '@grind/agent/tokens.bin': 'AG' } },
    { tree: { 'Grind/tokens.bin': 'G', 'Timo/agent.db': 'KEEP', 'Grind/agent.db': 'LEGACY-DB', 'Grind/preferences.json': 'P' } },
  ],
  random: (rng) => ({ tree: genTree(rng) }),
  call: ({ tree }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'timo-mig-parity-'));
    try {
      build(root, tree);
      migrateLegacyUserData(path.join(root, CURRENT));
      return dumpTree(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
};

export const specs: FnSpec<any>[] = [spec];
