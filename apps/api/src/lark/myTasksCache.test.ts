import { describe, it, expect, vi } from 'vitest';
import { CreatorNameCache, MyTasksCache, cloneTasks, isTransientLarkFetchError, type MyTasksSnapshot } from './myTasksCache';
import type { LarkTaskDto } from './tasks';

function task(guid: string): LarkTaskDto {
  return {
    guid,
    summary: guid,
    completed: false,
    due: null,
    createdAt: null,
    creatorId: null,
    creatorName: null,
    loggedMs: 0,
    loggedTodayMs: 0,
    loggedTotalMs: 0,
  };
}

function snap(...guids: string[]): MyTasksSnapshot {
  return { tasks: guids.map(task), creatorNames: null };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('MyTasksCache', () => {
  it('serves a fresh list from cache until the TTL passes', async () => {
    let now = 1_000;
    const cache = new MyTasksCache({ ttlMs: 100, now: () => now });
    const fetcher = vi.fn(async () => snap('a'));
    expect((await cache.get('u1', fetcher)).source).toBe('fresh');
    now += 99;
    expect((await cache.get('u1', fetcher)).source).toBe('cache');
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 1;
    await cache.get('u1', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps people apart', async () => {
    const cache = new MyTasksCache();
    await cache.get('u1', async () => snap('a'));
    const { snapshot } = await cache.get('u2', async () => snap('b'));
    expect(snapshot.tasks.map((t) => t.guid)).toEqual(['b']);
  });

  it('coalesces concurrent callers into one fetch', async () => {
    const cache = new MyTasksCache();
    const d = deferred<MyTasksSnapshot>();
    const fetcher = vi.fn(() => d.promise);
    const calls = [cache.get('u1', fetcher), cache.get('u1', fetcher), cache.get('u1', fetcher)];
    d.resolve(snap('a'));
    const results = await Promise.all(calls);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.snapshot.tasks[0]!.guid === 'a')).toBe(true);
  });

  it('answers a slow refresh with the last-good list, then keeps the refresh', async () => {
    let now = 0;
    const cache = new MyTasksCache({ ttlMs: 10, softTimeoutMs: 20, now: () => now });
    await cache.get('u1', async () => snap('old'));
    now = 50;
    const d = deferred<MyTasksSnapshot>();
    const slow = await cache.get('u1', () => d.promise);
    expect(slow.source).toBe('stale');
    expect(slow.snapshot.tasks[0]!.guid).toBe('old');
    d.resolve(snap('new'));
    await d.promise;
    await new Promise((r) => setTimeout(r, 0));
    const after = await cache.get('u1', vi.fn());
    expect(after.source).toBe('cache');
    expect(after.snapshot.tasks[0]!.guid).toBe('new');
  });

  it('waits for the fetch when there is no last-good list', async () => {
    const cache = new MyTasksCache({ softTimeoutMs: 5 });
    const { snapshot, source } = await cache.get('u1', () => new Promise((r) => setTimeout(() => r(snap('a')), 30)));
    expect(source).toBe('fresh');
    expect(snapshot.tasks[0]!.guid).toBe('a');
  });

  it('does not serve a last-good list older than staleMaxMs', async () => {
    let now = 0;
    const cache = new MyTasksCache({ ttlMs: 10, staleMaxMs: 100, softTimeoutMs: 5, now: () => now });
    await cache.get('u1', async () => snap('old'));
    now = 1_000;
    const { snapshot, source } = await cache.get('u1', () => new Promise((r) => setTimeout(() => r(snap('new')), 30)));
    expect(source).toBe('fresh');
    expect(snapshot.tasks[0]!.guid).toBe('new');
  });

  it('passes errors through, and keeps the last-good list after a failed refresh', async () => {
    let now = 0;
    const cache = new MyTasksCache({ ttlMs: 10, now: () => now });
    await expect(cache.get('u1', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await cache.get('u1', async () => snap('good'));
    now = 50;
    await expect(cache.get('u1', async () => { throw new Error('lark said no'); })).rejects.toThrow('lark said no');
    // Not poisoned: a transient-tolerant cache would still have 'good'.
    const tolerant = new MyTasksCache({ ttlMs: 10, now: () => now, canServeStaleOn: () => true });
    now = 0;
    await tolerant.get('u1', async () => snap('good'));
    now = 50;
    const r = await tolerant.get('u1', async () => { throw new TypeError('fetch failed'); });
    expect(r).toMatchObject({ source: 'stale' });
    expect(r.snapshot.tasks[0]!.guid).toBe('good');
  });

  it('invalidate forgets the list, and an in-flight answer from before is not kept', async () => {
    const cache = new MyTasksCache();
    await cache.get('u1', async () => snap('a'));
    cache.invalidate('u1');
    const fetcher = vi.fn(async () => snap('b'));
    expect((await cache.get('u1', fetcher)).snapshot.tasks[0]!.guid).toBe('b');
    expect(fetcher).toHaveBeenCalledTimes(1);

    const d = deferred<MyTasksSnapshot>();
    cache.invalidate('u1');
    const pending = cache.get('u1', () => d.promise);
    cache.invalidate('u1');
    d.resolve(snap('pre-change'));
    expect((await pending).snapshot.tasks[0]!.guid).toBe('pre-change');
    const next = vi.fn(async () => snap('post-change'));
    expect((await cache.get('u1', next)).snapshot.tasks[0]!.guid).toBe('post-change');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('cloneTasks gives copies callers can decorate', async () => {
    const cache = new MyTasksCache();
    const { snapshot } = await cache.get('u1', async () => snap('a'));
    const copy = cloneTasks(snapshot.tasks);
    copy[0]!.loggedMs = 123;
    expect(snapshot.tasks[0]!.loggedMs).toBe(0);
  });
});

describe('CreatorNameCache', () => {
  it('looks up only ids it has not seen, and retries ids it could not name', async () => {
    const cache = new CreatorNameCache();
    const lookup = vi.fn(async (ids: string[]) => new Map(ids.filter((id) => id !== 'ou_x').map((id) => [id, `N ${id}`])));
    expect(await cache.resolve(['ou_a', 'ou_b', 'ou_x'], lookup)).toEqual(new Map([['ou_a', 'N ou_a'], ['ou_b', 'N ou_b']]));
    expect(await cache.resolve(['ou_a', 'ou_c', 'ou_x'], lookup)).toEqual(new Map([['ou_a', 'N ou_a'], ['ou_c', 'N ou_c']]));
    expect(lookup).toHaveBeenLastCalledWith(['ou_c', 'ou_x']);
    lookup.mockClear();
    await cache.resolve(['ou_a', 'ou_b'], lookup);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('expires names after the TTL', async () => {
    let now = 0;
    const cache = new CreatorNameCache(100, 10, () => now);
    const lookup = vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, id])));
    await cache.resolve(['ou_a'], lookup);
    now = 100;
    await cache.resolve(['ou_a'], lookup);
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});

describe('isTransientLarkFetchError', () => {
  it('accepts network failures and timeouts only', () => {
    expect(isTransientLarkFetchError(new TypeError('fetch failed'))).toBe(true);
    expect(isTransientLarkFetchError(Object.assign(new Error('t'), { name: 'TimeoutError' }))).toBe(true);
    expect(isTransientLarkFetchError(new Error('lark list task error: 99991663'))).toBe(false);
    expect(isTransientLarkFetchError('nope')).toBe(false);
  });
});
