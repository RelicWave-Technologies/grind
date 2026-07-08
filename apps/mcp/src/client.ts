import type { TimoMcpConfig } from './config';

export class TimoApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `Timo API returned HTTP ${status}`;
    super(message);
    this.name = 'TimoApiError';
    this.status = status;
    this.body = body;
  }
}

export class TimoClient {
  private readonly apiBase: string;
  private readonly apiToken: string;

  constructor(config: TimoMcpConfig) {
    this.apiBase = config.apiBase;
    this.apiToken = config.apiToken;
  }

  async get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(path, this.apiBase);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.apiToken}`,
      },
    });

    const text = await res.text();
    const body = parseJson(text);
    if (!res.ok) throw new TimoApiError(res.status, body);
    return body as T;
  }
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
