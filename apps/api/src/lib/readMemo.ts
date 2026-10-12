import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestHandler } from 'express';

/**
 * A per-request memo for reads that several loaders repeat.
 *
 * A report request reads the workspace's leave policy three to five times and
 * the Working Calendar's rows twice (once for the attendance rules' late
 * count, once for the report itself), each from a different module. Plumbing
 * one loaded copy through all of them would couple modules that are
 * deliberately separate; instead, inside a memo scope, `memoizedRead` hands the
 * second caller the first caller's promise.
 *
 * Only for READ-ONLY requests: a scope is opened by `readMemoScope` on GET
 * routes whose handlers do not write, so nothing read here can be made stale
 * by the same request. Outside a scope `memoizedRead` simply loads.
 */

const scope = new AsyncLocalStorage<Map<string, Promise<unknown>>>();

/** Open a memo scope for the rest of a GET request (non-GETs pass through untouched). */
export const readMemoScope: RequestHandler = (req, _res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  scope.run(new Map(), next);
};

/** Run `fn` inside a fresh memo scope (scripts, tests). */
export function withReadMemo<T>(fn: () => T): T {
  return scope.run(new Map(), fn);
}

/**
 * `load()`, once per key per scope. A failed load is forgotten so a later
 * caller retries it. The value is shared: callers must not mutate it.
 */
export function memoizedRead<T>(key: string, load: () => Promise<T>): Promise<T> {
  const memo = scope.getStore();
  if (!memo) return load();
  const hit = memo.get(key) as Promise<T> | undefined;
  if (hit) return hit;
  const pending = load();
  memo.set(key, pending);
  pending.catch(() => {
    if (memo.get(key) === pending) memo.delete(key);
  });
  return pending;
}
