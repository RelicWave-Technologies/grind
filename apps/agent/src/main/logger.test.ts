import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// A real temp dir stands in for userData. `getPath` is only called lazily on
// the first log write (inside the tests), so this const is assigned by then.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'timo-log-'));

vi.mock('electron', () => ({ app: { getPath: () => userData } }));

const { log, logFilePath } = await import('./logger');

afterAll(() => fs.rmSync(userData, { recursive: true, force: true }));

describe('logger file sink', () => {
  it('writes log lines to userData/logs/main.log', () => {
    log.info('hello world', { a: 1 });
    const file = logFilePath();
    expect(file).toBe(path.join(userData, 'logs', 'main.log'));
    const contents = fs.readFileSync(file as string, 'utf8');
    expect(contents).toContain('INFO hello world');
    expect(contents).toContain('{"a":1}');
  });

  it('never throws on unserializable fields', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => log.warn('circular', circular)).not.toThrow();
    expect(fs.readFileSync(logFilePath() as string, 'utf8')).toContain('[unserializable-fields]');
  });
});
