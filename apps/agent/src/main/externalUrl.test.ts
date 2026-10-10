import { describe, expect, it } from 'vitest';
import { isSafeExternalUrl } from './externalUrl';

describe('isSafeExternalUrl', () => {
  it('allows https', () => {
    expect(isSafeExternalUrl('https://timo.example.com/dashboard')).toBe(true);
  });

  it('refuses every other scheme a config value could carry', () => {
    for (const url of [
      'http://timo.example.com',
      'file:///etc/passwd',
      'smb://evil/share',
      'javascript:alert(1)',
      'timo://callback',
      'x-apple.systempreferences:com.apple.preference.security',
      'not a url',
      '',
    ]) {
      expect(isSafeExternalUrl(url), url).toBe(false);
    }
  });

  it('refuses credentials embedded in the URL', () => {
    expect(isSafeExternalUrl('https://user:pass@timo.example.com')).toBe(false);
  });

  it('allows plain http only to this machine, and only in development', () => {
    expect(isSafeExternalUrl('http://localhost:5173')).toBe(false);
    expect(isSafeExternalUrl('http://localhost:5173', { allowLocalHttp: true })).toBe(true);
    expect(isSafeExternalUrl('http://127.0.0.1:5173', { allowLocalHttp: true })).toBe(true);
    expect(isSafeExternalUrl('http://timo.example.com', { allowLocalHttp: true })).toBe(false);
  });
});
