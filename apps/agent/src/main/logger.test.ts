import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// A real temp dir stands in for userData. `getPath` is only called lazily on
// the first log write (inside the tests), so this const is assigned by then.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'timo-log-'));

const appState = vi.hoisted(() => ({ isPackaged: false }));
vi.mock('electron', () => ({
  app: {
    getPath: () => userData,
    get isPackaged() {
      return appState.isPackaged;
    },
  },
}));

const { createRepeatLimitedErrorLog, flushLogs, log, logFilePath, logRetryDelayMs, rotateLogFiles } = await import('./logger');

afterAll(async () => {
  await flushLogs();
  fs.rmSync(userData, { recursive: true, force: true });
});

describe('logger file sink', () => {
  it('writes queued log lines to userData/logs/main.log', async () => {
    log.info('hello world', { a: 1 });
    await flushLogs();
    const file = logFilePath();
    expect(file).toBe(path.join(userData, 'logs', 'main.log'));
    const contents = fs.readFileSync(file as string, 'utf8');
    expect(contents).toContain('INFO hello world');
    expect(contents).toContain('{"a":1}');
  });

  it('never throws on unserializable fields', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => log.warn('circular', circular)).not.toThrow();
    await flushLogs();
    expect(fs.readFileSync(logFilePath() as string, 'utf8')).toContain('[unserializable-fields]');
  });

  it('preserves line order across a batched flush', async () => {
    log.info('ordered-first');
    log.info('ordered-second');
    await flushLogs();

    const contents = fs.readFileSync(logFilePath() as string, 'utf8');
    expect(contents.indexOf('ordered-first')).toBeLessThan(contents.indexOf('ordered-second'));
  });
});

describe('logger resilience', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    appState.isPackaged = false;
  });

  it('keeps logging after a failed write instead of switching the file off', async () => {
    // Windows antivirus holding main.log open used to end file logging for the session.
    const busy = Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    vi.spyOn(fs.promises, 'appendFile').mockRejectedValueOnce(busy);

    log.warn('written-after-retry');
    await flushLogs();
    expect(fs.readFileSync(logFilePath() as string, 'utf8')).not.toContain('written-after-retry');

    log.info('later-line');
    await flushLogs();
    const contents = fs.readFileSync(logFilePath() as string, 'utf8');
    expect(contents).toContain('written-after-retry');
    expect(contents).toContain('later-line');
    expect(contents.indexOf('written-after-retry')).toBeLessThan(contents.indexOf('later-line'));
  });

  it('backs off 1s, 2s, 4s … up to a minute', () => {
    expect(logRetryDelayMs(0)).toBe(0);
    expect(logRetryDelayMs(1)).toBe(1_000);
    expect(logRetryDelayMs(2)).toBe(2_000);
    expect(logRetryDelayMs(3)).toBe(4_000);
    expect(logRetryDelayMs(20)).toBe(60_000);
  });

  it('keeps DEBUG out of packaged builds', async () => {
    appState.isPackaged = true;
    log.debug('packaged-debug-line');
    log.info('packaged-info-line');
    await flushLogs();
    const contents = fs.readFileSync(logFilePath() as string, 'utf8');
    expect(contents).not.toContain('packaged-debug-line');
    expect(contents).toContain('packaged-info-line');
  });

  it('rotates through several older files, dropping only the oldest', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timo-rotate-'));
    const file = path.join(dir, 'main.log');
    try {
      for (let i = 1; i <= 6; i += 1) {
        fs.writeFileSync(file, `generation ${i}`);
        await rotateLogFiles(file, 4);
      }
      expect(fs.existsSync(file)).toBe(false);
      expect(fs.readFileSync(`${file}.1`, 'utf8')).toBe('generation 6');
      expect(fs.readFileSync(`${file}.4`, 'utf8')).toBe('generation 3');
      expect(fs.existsSync(`${file}.5`)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createRepeatLimitedErrorLog', () => {
  it('logs each distinct error once, then once per quiet period with what was held back', () => {
    let now = 0;
    const write = vi.fn();
    const logError = createRepeatLimitedErrorLog('tick failed', 60_000, () => now, write);

    for (let i = 0; i < 5; i += 1) logError(new Error('db locked'));
    logError(new Error('disk full'));
    expect(write.mock.calls.map(([, fields]) => fields.err)).toEqual(['Error: db locked', 'Error: disk full']);

    now = 60_000;
    logError(new Error('db locked'));
    expect(write).toHaveBeenCalledTimes(3);
    expect(write.mock.calls[2]![1]).toMatchObject({ err: 'Error: db locked', repeatsSinceLastLog: 4 });
  });

  it('never throws, even when the error cannot be printed or the write fails', () => {
    const unprintable = { toString: () => { throw new Error('no'); } };
    expect(() => createRepeatLimitedErrorLog('x', 1, () => 0, vi.fn())(unprintable)).not.toThrow();
    const failingWrite = () => { throw new Error('sink down'); };
    expect(() => createRepeatLimitedErrorLog('x', 1, () => 0, failingWrite)(new Error('e'))).not.toThrow();
  });
});
