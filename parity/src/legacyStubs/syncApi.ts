// `services/apiClient.ts` as the sync services see it: the REAL `HttpError` and
// `UnauthorizedError` classes (the uploader's policy uses `instanceof`), and an
// `api()` that records the request exactly as `apiClient.ts::rawFetch` would
// send it (`JSON.stringify(body)`) and answers from the scripted handler.
import { sync } from './syncState';

const real = (await import(new URL('../../../legacy/agent/src/main/services/apiClient.ts', import.meta.url).href)) as {
  HttpError: new (path: string, status: number, body: string) => Error & { status: number };
  UnauthorizedError: new (message: string) => Error;
};

export const HttpError = real.HttpError;
export const UnauthorizedError = real.UnauthorizedError;

export async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; auth?: boolean; timeoutMs?: number } = {},
): Promise<T> {
  sync.apiCalls.push({
    path,
    method: opts.method ?? 'GET',
    auth: opts.auth ?? null,
    timeoutMs: opts.timeoutMs ?? null,
    bodyText: opts.body !== undefined ? JSON.stringify(opts.body) : null,
  });
  return (await sync.apiHandler(path, opts)) as T;
}
