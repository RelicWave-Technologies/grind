import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

describe('loadConfig', () => {
  it('returns a clean config from env', () => {
    expect(loadConfig({
      TIMO_API_BASE: 'https://timo.example.com/',
      TIMO_API_TOKEN: ' timo_mcp_atk_123456789012.secret ',
    })).toEqual({
      apiBase: 'https://timo.example.com',
      apiToken: 'timo_mcp_atk_123456789012.secret',
    });
  });

  it('throws a clean error when required env is missing', () => {
    expect(() => loadConfig({})).toThrow('Missing required environment variable');
  });

  it('rejects invalid API base URLs', () => {
    expect(() => loadConfig({
      TIMO_API_BASE: 'not a url',
      TIMO_API_TOKEN: 'token',
    })).toThrow('TIMO_API_BASE must be a valid http(s) URL');
  });

  it('rejects non-http API base URLs', () => {
    expect(() => loadConfig({
      TIMO_API_BASE: 'ftp://timo.example.com',
      TIMO_API_TOKEN: 'token',
    })).toThrow('TIMO_API_BASE must be a valid http(s) URL');
  });
});
