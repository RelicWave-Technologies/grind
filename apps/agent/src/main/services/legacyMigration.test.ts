import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// `getPath` is read lazily inside the function (test body), so `state` is set
// by the time it's called.
const state = { userData: '' };
vi.mock('electron', () => ({ app: { getPath: () => state.userData } }));
vi.mock('../logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { migrateLegacyUserData } = await import('./legacyMigration');

const created: string[] = [];
function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'timo-mig-'));
  created.push(root);
  return root;
}
afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('migrateLegacyUserData', () => {
  it('copies token files from a legacy app dir when the current dir has no session', () => {
    const root = makeRoot();
    const legacy = path.join(root, 'Grind');
    const current = path.join(root, 'Timo');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'tokens.bin'), 'TOKENS');
    fs.writeFileSync(path.join(legacy, 'pending-lark-login.bin'), 'PENDING');
    state.userData = current;

    migrateLegacyUserData();

    expect(fs.readFileSync(path.join(current, 'tokens.bin'), 'utf8')).toBe('TOKENS');
    expect(fs.readFileSync(path.join(current, 'pending-lark-login.bin'), 'utf8')).toBe('PENDING');
    expect(fs.existsSync(path.join(legacy, 'tokens.bin'))).toBe(false);
    expect(fs.existsSync(path.join(legacy, 'tokens.bin.migrated-to-timo'))).toBe(true);
    expect(fs.existsSync(path.join(legacy, 'pending-lark-login.bin'))).toBe(false);
    expect(fs.existsSync(path.join(legacy, 'pending-lark-login.bin.migrated-to-timo'))).toBe(true);
  });

  it('copies local state from the scoped package-name app dir', () => {
    const root = makeRoot();
    const legacy = path.join(root, '@grind', 'agent');
    const current = path.join(root, 'Timo');
    fs.mkdirSync(path.join(legacy, 'screenshots'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'tokens.bin'), 'TOKENS');
    fs.writeFileSync(path.join(legacy, 'agent.db'), 'DB');
    fs.writeFileSync(path.join(legacy, 'preferences.json'), '{"floatingBarVisible":true}');
    fs.writeFileSync(path.join(legacy, 'screenshots', 'shot.jpg'), 'JPEG');
    state.userData = current;

    migrateLegacyUserData();

    expect(fs.readFileSync(path.join(current, 'tokens.bin'), 'utf8')).toBe('TOKENS');
    expect(fs.readFileSync(path.join(current, 'agent.db'), 'utf8')).toBe('DB');
    expect(fs.readFileSync(path.join(current, 'preferences.json'), 'utf8')).toBe('{"floatingBarVisible":true}');
    expect(fs.readFileSync(path.join(current, 'screenshots', 'shot.jpg'), 'utf8')).toBe('JPEG');
    expect(fs.existsSync(path.join(legacy, 'tokens.bin'))).toBe(false);
    expect(fs.existsSync(path.join(legacy, 'tokens.bin.migrated-to-timo'))).toBe(true);
    expect(fs.existsSync(path.join(legacy, 'screenshots'))).toBe(false);
    expect(fs.existsSync(path.join(legacy, 'screenshots.migrated-to-timo'))).toBe(true);
  });

  it('does not overwrite an existing session in the current dir', () => {
    const root = makeRoot();
    const legacy = path.join(root, 'Grind');
    const current = path.join(root, 'Timo');
    fs.mkdirSync(legacy, { recursive: true });
    fs.mkdirSync(current, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'tokens.bin'), 'OLD');
    fs.writeFileSync(path.join(current, 'tokens.bin'), 'CURRENT');
    state.userData = current;

    migrateLegacyUserData();

    expect(fs.readFileSync(path.join(current, 'tokens.bin'), 'utf8')).toBe('CURRENT');
  });

  it('is a no-op (no throw) when there is no legacy dir', () => {
    const root = makeRoot();
    const current = path.join(root, 'Timo');
    fs.mkdirSync(current, { recursive: true });
    state.userData = current;

    expect(() => migrateLegacyUserData()).not.toThrow();
    expect(fs.existsSync(path.join(current, 'tokens.bin'))).toBe(false);
  });
});
