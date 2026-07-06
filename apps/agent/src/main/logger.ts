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
let cachedLogFile: string | null = null;
let fileDisabled = false;
let sinceRotateCheck = 50; // start high so the first write checks immediately

function resolveLogFile(): string | null {
  if (cachedLogFile || fileDisabled) return cachedLogFile;
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    cachedLogFile = path.join(dir, 'main.log');
  } catch {
    fileDisabled = true; // e.g. app path unavailable in tests / no write access
  }
  return cachedLogFile;
}

/** Keep one previous file: main.log -> main.log.1 (overwriting the older one). */
function rotateIfNeeded(file: string): void {
  sinceRotateCheck += 1;
  if (sinceRotateCheck < 50) return;
  sinceRotateCheck = 0;
  try {
    if (fs.statSync(file).size < MAX_BYTES) return;
    fs.rmSync(`${file}.1`, { force: true });
    fs.renameSync(file, `${file}.1`);
  } catch {
    // best-effort — a rotation hiccup must never break logging
  }
}

function writeToFile(line: string): void {
  const file = resolveLogFile();
  if (!file) return;
  try {
    rotateIfNeeded(file);
    fs.appendFileSync(file, `${line}\n`); // sync so a crash can't lose the last lines
  } catch {
    fileDisabled = true; // stop hammering a broken sink
  }
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
  consoleFn(line);
  writeToFile(line);
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
