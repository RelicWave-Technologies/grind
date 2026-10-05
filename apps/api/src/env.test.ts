import { describe, it, expect, afterEach } from 'vitest';
import { dashboardOrigins, parseUrlList } from './env';

const prev = process.env.DASHBOARD_URL;
afterEach(() => {
  if (prev === undefined) delete process.env.DASHBOARD_URL;
  else process.env.DASHBOARD_URL = prev;
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

  it('dashboardOrigins reads the current value', () => {
    process.env.DASHBOARD_URL = 'https://x.example/,https://y.example';
    expect(dashboardOrigins()).toEqual(['https://x.example', 'https://y.example']);
  });
});
