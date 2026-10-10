import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {}, Notification: { isSupported: () => false } }));
vi.mock('../logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { AGENT_DB_BUSY_TIMEOUT_MS, openAgentDbAt } = await import('./agentDb');

let dir: string;
let file: string;

function deps(patch: Partial<Parameters<typeof openAgentDbAt>[1]> = {}) {
  return {
    open: (f: string) => new Database(f),
    fs,
    now: () => Date.parse('2026-10-10T08:00:00.000Z'),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    notifyReset: vi.fn(),
    ...patch,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timo-agentdb-'));
  file = path.join(dir, 'agent.db');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('openAgentDbAt', () => {
  it('opens a healthy database in WAL with a busy timeout and NORMAL sync', () => {
    const d = deps();
    const db = openAgentDbAt(file, d);
    try {
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(db.pragma('busy_timeout', { simple: true })).toBe(AGENT_DB_BUSY_TIMEOUT_MS);
      expect(db.pragma('synchronous', { simple: true })).toBe(1); // NORMAL
      expect(d.notifyReset).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('keeps the data of an existing healthy database', () => {
    const seed = new Database(file);
    seed.exec('CREATE TABLE t (v TEXT); INSERT INTO t VALUES (\'kept\');');
    seed.close();

    const db = openAgentDbAt(file, deps());
    try {
      expect(db.prepare('SELECT v FROM t').pluck().get()).toBe('kept');
    } finally {
      db.close();
    }
  });

  it('moves a corrupt file (and its WAL/SHM) aside, starts fresh, and tells the person', () => {
    fs.writeFileSync(file, Buffer.alloc(4096, 0x41)); // not a database
    fs.writeFileSync(`${file}-wal`, 'stale wal');
    fs.writeFileSync(`${file}-shm`, 'stale shm');
    const d = deps();

    const db = openAgentDbAt(file, d);
    try {
      db.exec('CREATE TABLE fresh (v INTEGER)');
      expect(db.pragma('quick_check', { simple: true })).toBe('ok');
    } finally {
      db.close();
    }

    const aside = fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'));
    expect(aside.sort()).toEqual([
      'agent.db.corrupt-2026-10-10T08-00-00-000Z',
      'agent.db.corrupt-2026-10-10T08-00-00-000Z-shm',
      'agent.db.corrupt-2026-10-10T08-00-00-000Z-wal',
    ]);
    expect(d.notifyReset).toHaveBeenCalledOnce();
    expect(d.log.error).toHaveBeenCalledWith(
      'agent db was corrupt; moved it aside and started a fresh one',
      expect.objectContaining({ moved: expect.any(Array) }),
    );
  });

  it('does not wipe anything for an error that is not corruption', () => {
    fs.writeFileSync(file, 'placeholder');
    const denied = Object.assign(new Error('unable to open database file'), { code: 'SQLITE_CANTOPEN' });

    expect(() => openAgentDbAt(file, deps({ open: () => { throw denied; } }))).toThrow(denied);
    expect(fs.readFileSync(file, 'utf8')).toBe('placeholder');
  });

  it('still opens when a notification cannot be shown', () => {
    fs.writeFileSync(file, Buffer.alloc(4096, 0x42));
    const db = openAgentDbAt(file, deps({ notifyReset: () => { throw new Error('not ready'); } }));
    db.close();
  });
});
