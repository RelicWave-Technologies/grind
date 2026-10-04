/**
 * The shared, mutable state of the timer parity harness: the network the stubbed
 * `api()` writes to. The scenario runner (`scenarios/timerRun.ts`) and the stub
 * (`timerApi.ts`) both import this one module, so they see one instance.
 */
export interface NetCall {
  kind: 'create' | 'sync';
  path: string;
  method: string;
  timeoutMs: number | null;
  body: string;
}

export interface NetItem extends NetCall {
  id: number;
  /** The entry snapshot the TimerService handed to the SyncClient for this call. */
  entry: unknown;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export const net: {
  pending: NetItem[];
  calls: NetCall[];
  nextId: number;
  /** Set by the spy SyncClient just before it calls the real HttpSyncClient. */
  currentEntry: unknown;
} = { pending: [], calls: [], nextId: 1, currentEntry: null };

export function resetNet(): void {
  net.pending = [];
  net.calls = [];
  net.nextId = 1;
  net.currentEntry = null;
}

/** What the stubbed `api()` does: record the request and wait to be delivered. */
export function netRequest(path: string, opts: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<unknown> {
  const method = opts.method ?? 'GET';
  const call: NetCall = {
    kind: method === 'POST' ? 'create' : 'sync',
    path,
    method,
    timeoutMs: opts.timeoutMs ?? null,
    body: JSON.stringify(opts.body ?? null),
  };
  net.calls.push(call);
  return new Promise((resolve, reject) => {
    net.pending.push({ ...call, id: net.nextId++, entry: net.currentEntry, resolve, reject });
  });
}
