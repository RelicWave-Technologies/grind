import { logger } from '../logger';
import type { LarkTaskDto } from './tasks';

/**
 * A short per-user cache in front of Lark's `my_tasks` list.
 *
 * The desktop agent asks for its task picker every few minutes and on every
 * window focus, so `/v1/lark/my-tasks` is the API's hottest route — and every
 * call used to wait on Lark (a paginated list, then a contact lookup), which
 * now and then takes the full 15-second outbound timeout. Three things here:
 *
 *  - FRESH: a list fetched less than `ttlMs` ago is served as is.
 *  - COALESCED: callers that arrive while a fetch for the same person is in
 *    flight share it instead of starting their own.
 *  - BOUNDED WAIT: when a refresh is slow and a last-good list exists (younger
 *    than `staleMaxMs`), the caller gets that list after `softTimeoutMs`; the
 *    refresh keeps running and updates the cache when it lands. With no
 *    last-good list the caller waits for the fetch, as before (still bounded
 *    by the outbound timeout).
 *
 * A failed refresh never poisons the cache: the last-good list stays. Errors
 * the caller must see (a revoked grant) are the fetcher's to throw and are
 * passed through, unless `canServeStaleOn(err)` says a last-good list may
 * answer for them.
 *
 * Only the Lark half is cached. The time logged against each task is read
 * from the database on every call, so it stays live.
 *
 * In-memory and per-process: the API runs as one container.
 */

export interface MyTasksSnapshot {
  tasks: LarkTaskDto[];
  /** Creator open_id → display name; null when the lookup was skipped or failed. */
  creatorNames: Map<string, string> | null;
}

interface Entry {
  value?: MyTasksSnapshot;
  fetchedAtMs?: number;
  inflight?: Promise<MyTasksSnapshot>;
}

export type MyTasksSource = 'fresh' | 'cache' | 'stale';

export interface MyTasksCacheOptions {
  ttlMs?: number;
  staleMaxMs?: number;
  softTimeoutMs?: number;
  maxEntries?: number;
  now?: () => number;
  /** May a last-good list answer for this fetch error? Default: never. */
  canServeStaleOn?: (err: unknown) => boolean;
  onBackgroundError?: (userId: string, err: unknown) => void;
}

export class MyTasksCache {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly staleMaxMs: number;
  private readonly softTimeoutMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly canServeStaleOn: (err: unknown) => boolean;
  private readonly onBackgroundError: (userId: string, err: unknown) => void;

  constructor(opts: MyTasksCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 45_000;
    this.staleMaxMs = opts.staleMaxMs ?? 60 * 60_000;
    this.softTimeoutMs = opts.softTimeoutMs ?? 5_000;
    this.maxEntries = opts.maxEntries ?? 5_000;
    this.now = opts.now ?? Date.now;
    this.canServeStaleOn = opts.canServeStaleOn ?? (() => false);
    this.onBackgroundError = opts.onBackgroundError ?? (() => {});
  }

  /**
   * The person's task list. The snapshot is shared — callers that change
   * tasks must copy them first (see `cloneTasks`).
   */
  async get(
    userId: string,
    fetcher: () => Promise<MyTasksSnapshot>,
  ): Promise<{ snapshot: MyTasksSnapshot; source: MyTasksSource }> {
    const entry = this.entries.get(userId) ?? {};
    const now = this.now();
    if (entry.value && entry.fetchedAtMs !== undefined && now - entry.fetchedAtMs < this.ttlMs) {
      return { snapshot: entry.value, source: 'cache' };
    }

    const inflight = entry.inflight ?? this.startFetch(userId, entry, fetcher);
    const lastGood = entry.value && entry.fetchedAtMs !== undefined && now - entry.fetchedAtMs < this.staleMaxMs
      ? entry.value
      : undefined;
    if (!lastGood) return { snapshot: await inflight, source: 'fresh' };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.softTimeoutMs);
      timer.unref?.();
    });
    try {
      const winner = await Promise.race([inflight, timedOut]);
      if (winner === 'timeout') {
        // The refresh is still running and will land in the cache; nobody is
        // left awaiting it, so its failure is only worth a log line.
        inflight.catch((err) => this.onBackgroundError(userId, err));
        return { snapshot: lastGood, source: 'stale' };
      }
      return { snapshot: winner, source: 'fresh' };
    } catch (err) {
      if (this.canServeStaleOn(err)) return { snapshot: lastGood, source: 'stale' };
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Forget a person's list (a task was created, Lark was (dis)connected). */
  invalidate(userId: string): void {
    this.entries.delete(userId);
  }

  clear(): void {
    this.entries.clear();
  }

  private startFetch(userId: string, entry: Entry, fetcher: () => Promise<MyTasksSnapshot>): Promise<MyTasksSnapshot> {
    const inflight = fetcher().then(
      (value) => {
        // Invalidated while in flight: the answer may predate the change, so
        // it is returned to its own callers but not kept.
        if (this.entries.get(userId) === entry) {
          entry.value = value;
          entry.fetchedAtMs = this.now();
        }
        return value;
      },
    ).finally(() => {
      if (entry.inflight === inflight) entry.inflight = undefined;
    });
    entry.inflight = inflight;
    if (!this.entries.has(userId)) {
      this.evictIfFull();
      this.entries.set(userId, entry);
    }
    return inflight;
  }

  private evictIfFull(): void {
    if (this.entries.size < this.maxEntries) return;
    const oldest = this.entries.keys().next().value as string | undefined;
    if (oldest !== undefined) this.entries.delete(oldest);
  }
}

/** Copies a caller may decorate (logged time, creator names) without touching the cache. */
export function cloneTasks(tasks: readonly LarkTaskDto[]): LarkTaskDto[] {
  return tasks.map((t) => ({ ...t }));
}

/**
 * Creator names change rarely and are shared across people, so they get a
 * longer, process-wide cache: only open_ids not seen recently are looked up.
 */
export class CreatorNameCache {
  private readonly names = new Map<string, { name: string; atMs: number }>();

  constructor(
    private readonly ttlMs = 6 * 60 * 60_000,
    private readonly maxEntries = 20_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Names for `openIds`, looking up only the ones not cached (best-effort). */
  async resolve(
    openIds: readonly string[],
    lookup: (missing: string[]) => Promise<Map<string, string>>,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const missing: string[] = [];
    const now = this.now();
    for (const id of new Set(openIds)) {
      const hit = this.names.get(id);
      if (hit && now - hit.atMs < this.ttlMs) {
        out.set(id, hit.name);
      } else {
        missing.push(id);
      }
    }
    if (missing.length === 0) return out;
    const found = await lookup(missing);
    const at = this.now();
    // Only real answers are kept; an id the lookup could not name is asked
    // about again next time rather than remembered as nameless.
    for (const id of missing) {
      const name = found.get(id);
      if (name === undefined) continue;
      out.set(id, name);
      this.remember(id, name, at);
    }
    return out;
  }

  clear(): void {
    this.names.clear();
  }

  private remember(id: string, name: string, atMs: number): void {
    if (!this.names.has(id) && this.names.size >= this.maxEntries) {
      const oldest = this.names.keys().next().value as string | undefined;
      if (oldest !== undefined) this.names.delete(oldest);
    }
    this.names.set(id, { name, atMs });
  }
}

/**
 * A fetch failure a last-good list may answer for: Lark unreachable or too
 * slow (network error, our outbound timeout). Lark answering with an error
 * code is passed through as before.
 */
export function isTransientLarkFetchError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'TimeoutError' || err.name === 'AbortError' || err.name === 'LarkTransientError'
    || (err instanceof TypeError && /fetch failed|network/i.test(err.message));
}

/** The process-wide caches behind GET /v1/lark/my-tasks. */
export const myTasksCache = new MyTasksCache({
  canServeStaleOn: isTransientLarkFetchError,
  onBackgroundError: (userId, err) =>
    logger.warn({ userId, err: err instanceof Error ? err.message : String(err) }, 'lark my-tasks background refresh failed'),
});
export const creatorNameCache = new CreatorNameCache();

/** Empty both caches (tests: in-memory state outlives a TRUNCATE). */
export function resetLarkTaskCachesForTests(): void {
  myTasksCache.clear();
  creatorNameCache.clear();
}
