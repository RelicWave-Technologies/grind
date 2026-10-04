// Stand-in for `services/apiClient.ts` as the timer sees it: an `HttpError` and an
// `api()` that queues the request instead of calling `fetch`.
//
// `apiClient.ts` itself cannot load under Node (it pulls env, logger and the
// Electron token store), so `HttpError` is re-declared here. The class text is
// checked against the real file at load time, so the copy cannot drift silently.
import { readFileSync } from 'node:fs';
import { netRequest } from './timerState';

export class HttpError extends Error {
  constructor(
    public readonly path: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`${path} ${status}: ${body}`);
    this.name = 'HttpError';
  }
}

const EXPECTED = `class HttpError extends Error {
  constructor(
    public readonly path: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(\`\${path} \${status}: \${body}\`);
    this.name = 'HttpError';
  }
}`;
const real = readFileSync(new URL('../../../legacy/agent/src/main/services/apiClient.ts', import.meta.url), 'utf8');
if (!real.includes(EXPECTED)) throw new Error('legacy apiClient.ts HttpError changed: update parity/src/legacyStubs/timerApi.ts');

export function api<T>(path: string, opts?: { method?: string; body?: unknown; timeoutMs?: number }): Promise<T> {
  return netRequest(path, opts) as Promise<T>;
}
