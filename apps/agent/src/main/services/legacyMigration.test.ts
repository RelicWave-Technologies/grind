import Database from 'better-sqlite3';
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

  it("repoints the copied queue's absolute screenshot paths at the new directory", () => {
    const root = makeRoot();
    const legacy = path.join(root, 'Grind');
    const current = path.join(root, 'Timo');
    fs.mkdirSync(path.join(legacy, 'screenshots', '2026-10-01'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'tokens.bin'), 'TOKENS');
    fs.writeFileSync(path.join(legacy, 'screenshots', '2026-10-01', 'a.webp'), 'WEBP');
    const legacyDb = new Database(path.join(legacy, 'agent.db'));
    legacyDb.exec(`CREATE TABLE screenshots (id TEXT PRIMARY KEY, file_path TEXT NOT NULL)`);
    const insert = legacyDb.prepare(`INSERT INTO screenshots (id, file_path) VALUES (?, ?)`);
    insert.run('abs', path.join(legacy, 'screenshots', '2026-10-01', 'a.webp'));
    insert.run('relative', path.join('screenshots', '2026-10-01', 'b.webp'));
    insert.run('elsewhere', path.join(root, 'Other', 'screenshots', 'c.webp'));
    legacyDb.close();
    state.userData = current;

    migrateLegacyUserData();

    const db = new Database(path.join(current, 'agent.db'), { readonly: true });
    const rows = Object.fromEntries(
      (db.prepare(`SELECT id, file_path FROM screenshots`).all() as Array<{ id: string; file_path: string }>)
        .map((row) => [row.id, row.file_path]),
    );
    db.close();
    expect(rows.abs).toBe(path.join(current, 'screenshots', '2026-10-01', 'a.webp'));
    expect(fs.existsSync(rows.abs!)).toBe(true);
    expect(rows.relative).toBe(path.join('screenshots', '2026-10-01', 'b.webp'));
    expect(rows.elsewhere).toBe(path.join(root, 'Other', 'screenshots', 'c.webp'));
  });

  it('copies the WAL alongside the database', () => {
    const root = makeRoot();
    const legacy = path.join(root, 'Grind');
    const current = path.join(root, 'Timo');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'tokens.bin'), 'TOKENS');
    fs.writeFileSync(path.join(legacy, 'agent.db-wal'), 'WAL');
    state.userData = current;

    migrateLegacyUserData();

    expect(fs.readFileSync(path.join(current, 'agent.db-wal'), 'utf8')).toBe('WAL');
  });

  it('leaves a database it cannot open exactly as copied', () => {
    const root = makeRoot();
    const legacy = path.join(root, 'Grind');
    const current = path.join(root, 'Timo');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'tokens.bin'), 'TOKENS');
    fs.writeFileSync(path.join(legacy, 'agent.db'), 'NOT A DATABASE');
    state.userData = current;

    expect(() => migrateLegacyUserData()).not.toThrow();
    expect(fs.readFileSync(path.join(current, 'agent.db'), 'utf8')).toBe('NOT A DATABASE');
    expect(fs.readFileSync(path.join(current, 'tokens.bin'), 'utf8')).toBe('TOKENS');
  });
});
