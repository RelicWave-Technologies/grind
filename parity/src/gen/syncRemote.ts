import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

/**
 * Runs one sync scenario in the child process of `syncChild.ts` and returns its
 * recorded output. The child is started on first use and ends when the
 * generator exits (its stdin closes with the parent; it is unref'd so it never
 * keeps the run alive).
 */
let child: ChildProcess | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let next = 0;
const waiting = new Map<number, (output: unknown) => void>();

function start(): ChildProcess {
  if (child) return child;
  const entry = fileURLToPath(new URL('./syncChild.ts', import.meta.url));
  const proc = spawn(process.execPath, ['--import', 'tsx', entry], { stdio: ['pipe', 'pipe', 'inherit'] });
  createInterface({ input: proc.stdout! }).on('line', (line) => {
    const { id, output } = JSON.parse(line) as { id: number; output: unknown };
    waiting.get(id)?.(output);
    waiting.delete(id);
    // Idle for a moment: end the child (stdin closes, it exits). A later request starts a fresh one.
    if (waiting.size === 0) idleTimer = setTimeout(closeRemote, 300);
  });
  proc.on('exit', () => {
    child = null;
  });
  child = proc;
  return proc;
}

export function remote(kind: 'flush' | 'auth' | 'upload', input: unknown): Promise<unknown> {
  const id = next++;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    start().stdin!.write(`${JSON.stringify({ id, kind, input })}\n`);
  });
}

/** Ends the child once every scenario is done (the generators call it when they finish). */
export function closeRemote(): void {
  child?.stdin?.end();
  child = null;
}
