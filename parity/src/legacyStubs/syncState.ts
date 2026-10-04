/**
 * The shared, mutable world of the timo-sync parity stubs (`sync*.ts`): what the
 * REAL `auth.ts`, `activity/sync.ts` and `capture/uploader.ts` reach for besides
 * the network (the API client, the token store, the browser, the screenshot
 * store, the file system's neighbours). A scenario resets it, sets the scripted
 * replies, runs the real function and reads back what happened.
 */
export interface ApiCall {
  path: string;
  method: string;
  auth: boolean | null;
  timeoutMs: number | null;
  bodyText: string | null;
}

export interface FetchCall {
  url: string;
  method: string;
  fields: Array<[string, string | { file: string; type: string; size: number }]>;
}

export type ApiHandler = (path: string, opts: { method?: string; body?: unknown; auth?: boolean; timeoutMs?: number }) => Promise<unknown>;

export interface SyncWorld {
  apiCalls: ApiCall[];
  apiHandler: ApiHandler;
  fetchCalls: FetchCall[];
  opened: string[];
  openFails: boolean;
  tokens: unknown;
  savedTokens: unknown[];
  clearedTokens: number;
  pending: { verifier: string; loginUrl: string; createdAt: number } | null;
  workspaceClears: number;
  storeCalls: string[];
  pendingRows: unknown[];
}

export const sync: SyncWorld = {
  apiCalls: [],
  apiHandler: async () => ({}),
  fetchCalls: [],
  opened: [],
  openFails: false,
  tokens: null,
  savedTokens: [],
  clearedTokens: 0,
  pending: null,
  workspaceClears: 0,
  storeCalls: [],
  pendingRows: [],
};

export function resetSync(): void {
  sync.apiCalls = [];
  sync.apiHandler = async () => ({});
  sync.fetchCalls = [];
  sync.opened = [];
  sync.openFails = false;
  sync.tokens = null;
  sync.savedTokens = [];
  sync.clearedTokens = 0;
  sync.pending = null;
  sync.workspaceClears = 0;
  sync.storeCalls = [];
  sync.pendingRows = [];
}

/**
 * The scenarios patch process-wide state (`Date.now`, `Math.random`, `fetch`,
 * `node:crypto`) and share `sync` above; the generator modules run their
 * top-level awaits concurrently, so every scenario takes this queue first.
 */
let tail: Promise<unknown> = Promise.resolve();
export function exclusive<T>(job: () => Promise<T>): Promise<T> {
  const run = tail.then(job, job);
  tail = run.then(() => undefined, () => undefined);
  return run;
}
