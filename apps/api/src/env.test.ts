import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';
import { dashboardOrigins, developerEmails, isDeveloperEmail, parseEmailList, parseUrlList } from './env';

const prev = process.env.DASHBOARD_URL;
const prevDevelopers = process.env.DEVELOPER_EMAILS;
afterEach(() => {
  if (prev === undefined) delete process.env.DASHBOARD_URL;
  else process.env.DASHBOARD_URL = prev;
  if (prevDevelopers === undefined) delete process.env.DEVELOPER_EMAILS;
  else process.env.DEVELOPER_EMAILS = prevDevelopers;
});

describe('DASHBOARD_URL', () => {
  it('parses one origin or a comma-separated list, trimmed and without trailing slashes', () => {
    expect(parseUrlList('https://a.example/')).toEqual(['https://a.example']);
    expect(parseUrlList(' https://a.example , https://b.example/ ')).toEqual(['https://a.example', 'https://b.example']);
  });

  it('treats empty as unset and drops entries that are not URLs', () => {
    expect(parseUrlList('')).toEqual([]);
    expect(parseUrlList(undefined)).toEqual([]);
    expect(parseUrlList('https://a.example,not a url')).toEqual(['https://a.example']);
  });

  it('is required in production, where CORS would otherwise reflect any origin with credentials', () => {
    // env.ts validates at import and exits, so load it in a fresh process.
    const boot = (extra: Record<string, string>) => spawnSync(
      process.execPath,
      ['--import', 'tsx', '-e', "await import('./src/env.ts')"],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: {
          PATH: process.env.PATH ?? '',
          DATABASE_URL: 'postgresql://user@localhost:5432/db',
          JWT_SECRET: 'x'.repeat(32),
          ...extra,
        },
        encoding: 'utf8',
      },
    );
    const missing = boot({ NODE_ENV: 'production' });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('DASHBOARD_URL');
    expect(boot({ NODE_ENV: 'production', DASHBOARD_URL: 'https://dash.example' }).status).toBe(0);
    expect(boot({ NODE_ENV: 'development' }).status).toBe(0);
  });

  it('dashboardOrigins reads the current value', () => {
    process.env.DASHBOARD_URL = 'https://x.example/,https://y.example';
    expect(dashboardOrigins()).toEqual(['https://x.example', 'https://y.example']);
  });
});

describe('DEVELOPER_EMAILS', () => {
  it('parses a trimmed, lowercased, comma-separated list', () => {
    expect(parseEmailList(' Dev@Example.com , ops@example.com ,')).toEqual(['dev@example.com', 'ops@example.com']);
    expect(parseEmailList('')).toEqual([]);
    expect(parseEmailList(undefined)).toEqual([]);
  });

  it('matches case-insensitively and is off when empty', () => {
    process.env.DEVELOPER_EMAILS = 'dev@example.com';
    expect(developerEmails()).toEqual(['dev@example.com']);
    expect(isDeveloperEmail(' DEV@example.com')).toBe(true);
    expect(isDeveloperEmail('other@example.com')).toBe(false);
    process.env.DEVELOPER_EMAILS = '';
    expect(isDeveloperEmail('dev@example.com')).toBe(false);
  });
});
