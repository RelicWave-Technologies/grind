export interface TimoMcpConfig {
  apiBase: string;
  apiToken: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): TimoMcpConfig {
  const apiBase = env.TIMO_API_BASE?.trim().replace(/\/$/, '');
  const apiToken = env.TIMO_API_TOKEN?.trim();
  const missing = [
    !apiBase ? 'TIMO_API_BASE' : null,
    !apiToken ? 'TIMO_API_TOKEN' : null,
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
  }

  try {
    const parsed = new URL(apiBase!);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('bad_protocol');
    }
  } catch {
    throw new Error('TIMO_API_BASE must be a valid http(s) URL');
  }

  return { apiBase: apiBase!, apiToken: apiToken! };
}
