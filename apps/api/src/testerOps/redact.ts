const TOKENISH = [
  /\b(cli|app|doc|wiki|node|blk)[A-Za-z0-9_-]{12,}\b/g,
  /\b[0-9]{16,}\b/g,
  /\b[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
  /\b(Bearer|tenant_access_token|refresh_token|app_secret|OPENROUTER_API_KEY|DEEPSEEK_API_KEY)\b[:=\s]+[^\s]+/gi,
];

export function redactText(input: string | null | undefined): string {
  let out = input ?? '';
  for (const pattern of TOKENISH) out = out.replace(pattern, '[redacted]');
  return out.slice(0, 4000);
}

export function redactJson(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactJson);
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (/secret|token|key|authorization|password/i.test(key)) {
      result[key] = '[redacted]';
    } else {
      result[key] = redactJson(raw);
    }
  }
  return result;
}

