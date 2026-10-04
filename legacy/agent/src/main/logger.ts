import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Main-process logger. Writes to BOTH the console (dev) and a rotating file
 * under `userData/logs/main.log` (packaged builds). A packaged Windows/macOS
 * app has no attached console, so the file sink is the only way to see what
 * happened in the field — every auth/deep-link breadcrumb lands there.
 *
 * The file sink is best-effort: any failure (path not ready, no write access)
 * disables it and falls back to console-only. Logging must never crash the app.
 */
type Fields = Record<string, unknown> | undefined;

const MAX_BYTES = 5 * 1024 * 1024; // rotate once main.log passes 5 MB
const FLUSH_DELAY_MS = 1_000;
const FLUSH_SIZE_BYTES = 64 * 1024;
const ROTATION_CHECK_BYTES = 256 * 1024;
let cachedLogFile: string | null = null;
let fileDisabled = false;
let pendingLines: string[] = [];
let pendingBytes = 0;
let bytesSinceRotateCheck = ROTATION_CHECK_BYTES;
let flushTimer: NodeJS.Timeout | null = null;
let writeChain = Promise.resolve();

function resolveLogFile(): string | null {
  if (cachedLogFile || fileDisabled) return cachedLogFile;
  try {
    cachedLogFile = path.join(app.getPath('userData'), 'logs', 'main.log');
  } catch {
    fileDisabled = true; // e.g. app path unavailable in tests / no write access
  }
  return cachedLogFile;
}

/** Keep one previous file: main.log -> main.log.1 (overwriting the older one). */
async function rotateIfNeeded(file: string, incomingBytes: number): Promise<void> {
  bytesSinceRotateCheck += incomingBytes;
  if (bytesSinceRotateCheck < ROTATION_CHECK_BYTES) return;
  bytesSinceRotateCheck = 0;
  try {
    const size = await fs.promises.stat(file).then((stat) => stat.size, () => 0);
    if (size + incomingBytes < MAX_BYTES) return;
    await fs.promises.rm(`${file}.1`, { force: true });
    await fs.promises.rename(file, `${file}.1`);
  } catch {
    // best-effort — a rotation hiccup must never break logging
  }
}

async function appendBatch(lines: string[], bytes: number): Promise<void> {
  const file = resolveLogFile();
  if (!file) return;
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await rotateIfNeeded(file, bytes);
    await fs.promises.appendFile(file, `${lines.join('\n')}\n`);
  } catch {
    fileDisabled = true; // stop hammering a broken sink
  }
}

function scheduleFlush(delayMs: number): void {
  if (flushTimer) {
    if (delayMs > 0) return;
    clearTimeout(flushTimer);
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushLogs();
  }, delayMs);
  flushTimer.unref?.();
}

function writeToFile(line: string, urgent: boolean): void {
  if (fileDisabled) return;
  pendingLines.push(line);
  pendingBytes += Buffer.byteLength(line) + 1;
  if (urgent || pendingBytes >= FLUSH_SIZE_BYTES) void flushLogs();
  else scheduleFlush(FLUSH_DELAY_MS);
}

/**
 * Flush queued log lines in call order without blocking Electron's main loop.
 * Multiple callers serialize through one promise chain; lines arriving during
 * a flush are drained by the next pass.
 */
export async function flushLogs(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  while (pendingLines.length > 0 && !fileDisabled) {
    const lines = pendingLines;
    const bytes = pendingBytes;
    pendingLines = [];
    pendingBytes = 0;
    writeChain = writeChain.then(() => appendBatch(lines, bytes));
    await writeChain;
  }
  await writeChain;
}

function safeFields(fields?: Fields): string {
  if (!fields) return '';
  try {
    return ` ${JSON.stringify(fields)}`;
  } catch {
    return ' [unserializable-fields]';
  }
}

function fmt(level: string, msg: string, fields?: Fields): string {
  const ts = new Date().toISOString();
  return `[${ts}] ${level} ${msg}${safeFields(fields)}`;
}

function emit(level: string, consoleFn: (msg: string) => void, msg: string, fields?: Fields): void {
  const line = fmt(level, msg, fields);
  if (!app.isPackaged) consoleFn(line);
  writeToFile(line, level === 'WARN' || level === 'ERROR');
}

export const log = {
  info: (msg: string, fields?: Fields) => emit('INFO', console.log, msg, fields),
  warn: (msg: string, fields?: Fields) => emit('WARN', console.warn, msg, fields),
  error: (msg: string, fields?: Fields) => emit('ERROR', console.error, msg, fields),
  debug: (msg: string, fields?: Fields) => emit('DEBUG', console.debug, msg, fields),
};

/** Absolute path to the active log file (null if file logging is unavailable).
 *  Handy for surfacing "open logs" in the UI or a support flow. */
export function logFilePath(): string | null {
  return resolveLogFile();
}
