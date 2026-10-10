import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Main-process logger. Writes to BOTH the console (dev) and a rotating file
 * under `userData/logs/main.log` (packaged builds). A packaged Windows/macOS
 * app has no attached console, so the file sink is the only way to see what
 * happened in the field — every auth/deep-link breadcrumb lands there.
 *
 * The file sink is best-effort and never crashes the app. A write that fails
 * (Windows antivirus holding the file — EBUSY — or a full disk) is retried
 * with backoff, keeping the lines queued (bounded), instead of switching file
 * logging off for the rest of the session: one transient error used to leave
 * a whole day of field logs blank. Only a log path that cannot be resolved at
 * all disables the sink. DEBUG lines stay out of packaged builds.
 */
type Fields = Record<string, unknown> | undefined;

const MAX_BYTES = 5 * 1024 * 1024; // rotate once main.log passes 5 MB
/** Rotated files kept beside main.log: main.log.1 (newest) … main.log.4. */
export const LOG_ROTATED_FILES = 4;
const FLUSH_DELAY_MS = 1_000;
const FLUSH_SIZE_BYTES = 64 * 1024;
const ROTATION_CHECK_BYTES = 256 * 1024;
/** Lines held while the file cannot be written; the oldest go first past this. */
const MAX_PENDING_BYTES = 2 * 1024 * 1024;
let cachedLogFile: string | null = null;
let fileDisabled = false;
let pendingLines: string[] = [];
let pendingBytes = 0;
let droppedLines = 0;
let bytesSinceRotateCheck = ROTATION_CHECK_BYTES;
let flushTimer: NodeJS.Timeout | null = null;
let writeChain = Promise.resolve();
let writeFailures = 0;
/** Device clock: no automatic flush before this while writes are failing. */
let retryAt = 0;

function resolveLogFile(): string | null {
  if (cachedLogFile || fileDisabled) return cachedLogFile;
  try {
    cachedLogFile = path.join(app.getPath('userData'), 'logs', 'main.log');
  } catch {
    fileDisabled = true; // e.g. app path unavailable in tests / no write access
  }
  return cachedLogFile;
}

/** 1s, 2s, 4s … capped at a minute, after `failures` consecutive failed writes. */
export function logRetryDelayMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(60_000, 1_000 * 2 ** Math.min(failures - 1, 6));
}

type RotateFs = Pick<typeof fs.promises, 'rm' | 'rename'>;

/** main.log -> main.log.1 -> … -> main.log.<keep>; the oldest is dropped. */
export async function rotateLogFiles(file: string, keep: number = LOG_ROTATED_FILES, fsp: RotateFs = fs.promises): Promise<void> {
  await fsp.rm(`${file}.${keep}`, { force: true });
  for (let i = keep - 1; i >= 1; i -= 1) {
    await fsp.rename(`${file}.${i}`, `${file}.${i + 1}`).catch(() => undefined);
  }
  await fsp.rename(file, `${file}.1`);
}

async function rotateIfNeeded(file: string, incomingBytes: number): Promise<void> {
  bytesSinceRotateCheck += incomingBytes;
  if (bytesSinceRotateCheck < ROTATION_CHECK_BYTES) return;
  bytesSinceRotateCheck = 0;
  try {
    const size = await fs.promises.stat(file).then((stat) => stat.size, () => 0);
    if (size + incomingBytes < MAX_BYTES) return;
    await rotateLogFiles(file);
  } catch {
    // best-effort — a rotation hiccup must never break logging
  }
}

/** Put lines that could not be written back at the front, within the cap. */
function requeue(lines: string[], bytes: number): void {
  pendingLines = [...lines, ...pendingLines];
  pendingBytes += bytes;
  while (pendingBytes > MAX_PENDING_BYTES && pendingLines.length > 0) {
    pendingBytes -= Buffer.byteLength(pendingLines.shift()!) + 1;
    droppedLines += 1;
  }
}

async function appendBatch(lines: string[], bytes: number): Promise<boolean> {
  const file = resolveLogFile();
  if (!file) return true;
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await rotateIfNeeded(file, bytes);
    const note = droppedLines > 0
      ? [`[${new Date().toISOString()}] WARN log lines dropped while the log file could not be written {"dropped":${droppedLines}}`]
      : [];
    await fs.promises.appendFile(file, `${[...note, ...lines].join('\n')}\n`);
    droppedLines = 0;
    writeFailures = 0;
    retryAt = 0;
    return true;
  } catch (err) {
    writeFailures += 1;
    const delay = logRetryDelayMs(writeFailures);
    // device<->device: only compared with later Date.now() readings.
    retryAt = Date.now() + delay;
    requeue(lines, bytes);
    if (writeFailures === 1 && !app.isPackaged) console.warn(`log file write failed; retrying: ${String(err)}`);
    scheduleFlush(delay);
    return false;
  }
}

function scheduleFlush(delayMs: number): void {
  if (flushTimer) {
    if (delayMs > 0) return;
    clearTimeout(flushTimer);
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, delayMs);
  flushTimer.unref?.();
}

function writeToFile(line: string, urgent: boolean): void {
  if (fileDisabled) return;
  pendingLines.push(line);
  pendingBytes += Buffer.byteLength(line) + 1;
  if (pendingBytes > MAX_PENDING_BYTES) requeue([], 0);
  const backingOff = Date.now() < retryAt;
  if (backingOff) scheduleFlush(Math.max(1, retryAt - Date.now()));
  else if (urgent || pendingBytes >= FLUSH_SIZE_BYTES) void flush();
  else scheduleFlush(FLUSH_DELAY_MS);
}

async function flush(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  while (pendingLines.length > 0 && !fileDisabled) {
    const lines = pendingLines;
    const bytes = pendingBytes;
    pendingLines = [];
    pendingBytes = 0;
    let written = true;
    writeChain = writeChain.then(async () => {
      written = await appendBatch(lines, bytes);
    });
    await writeChain;
    // A failed write re-queued its lines and scheduled the retry.
    if (!written) break;
  }
  await writeChain;
}

/**
 * Flush queued log lines in call order without blocking Electron's main loop.
 * Multiple callers serialize through one promise chain; lines arriving during
 * a flush are drained by the next pass. An explicit flush (quit) always tries,
 * even while automatic retries are backing off.
 */
export async function flushLogs(): Promise<void> {
  await flush();
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
  // DEBUG is for development; in the field it only buries the lines that matter.
  if (level === 'DEBUG' && app.isPackaged) return;
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
