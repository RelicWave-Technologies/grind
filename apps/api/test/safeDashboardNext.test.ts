import { describe, expect, it } from 'vitest';
import { safeDashboardNext } from '../src/routes/authLark';

describe('safeDashboardNext', () => {
  it('keeps same-origin paths', () => {
    expect(safeDashboardNext('/approvals?tab=time')).toBe('/approvals?tab=time');
  });

  it('refuses anything that resolves off the dashboard', () => {
    for (const next of ['/\\evil.com', '/\\/evil.com', '//evil.com', 'https://evil.com', 'evil.com']) {
      expect(safeDashboardNext(next), next).toBeUndefined();
    }
  });
});
