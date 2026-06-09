import { describe, it, expect } from 'vitest';
import {
  applyPolicyToActive,
  WORKSPACE_POLICY_DEFAULTS,
  PatchWorkspacePolicyRequest,
  ActivitySampleInput,
} from '@grind/types';

describe('applyPolicyToActive', () => {
  const sample = {
    activeApp: 'Google Chrome',
    activeAppBundle: 'com.google.Chrome',
    activeTitle: 'Inbox · me@example.com',
    activeUrl: 'https://mail.google.com/inbox',
  };

  it('strips everything when captureApps is off', () => {
    const out = applyPolicyToActive(sample, { captureApps: false, captureTitles: true, captureUrls: true });
    expect(out).toEqual({
      activeApp: null,
      activeAppBundle: null,
      activeTitle: null,
      activeUrl: null,
    });
  });

  it('keeps app + bundle but drops title + url when captureApps only', () => {
    const out = applyPolicyToActive(sample, { captureApps: true, captureTitles: false, captureUrls: false });
    expect(out.activeApp).toBe('Google Chrome');
    expect(out.activeAppBundle).toBe('com.google.Chrome');
    expect(out.activeTitle).toBeNull();
    expect(out.activeUrl).toBeNull();
  });

  it('keeps title when captureTitles is on but drops url', () => {
    const out = applyPolicyToActive(sample, { captureApps: true, captureTitles: true, captureUrls: false });
    expect(out.activeTitle).toBe('Inbox · me@example.com');
    expect(out.activeUrl).toBeNull();
  });

  it('keeps everything when all flags are on', () => {
    const out = applyPolicyToActive(sample, { captureApps: true, captureTitles: true, captureUrls: true });
    expect(out).toEqual(sample);
  });

  it('does not mutate the original sample', () => {
    const original = { ...sample };
    applyPolicyToActive(sample, { captureApps: false, captureTitles: false, captureUrls: false });
    expect(sample).toEqual(original);
  });

  it('preserves non-active fields the caller passed in', () => {
    const wide = { ...sample, keystrokes: 42, userId: 'u1' };
    const out = applyPolicyToActive(wide, { captureApps: true, captureTitles: false, captureUrls: false });
    expect(out.keystrokes).toBe(42);
    expect(out.userId).toBe('u1');
  });
});

describe('WORKSPACE_POLICY_DEFAULTS', () => {
  it('keeps capture flags off by default (privacy-first)', () => {
    expect(WORKSPACE_POLICY_DEFAULTS.captureApps).toBe(false);
    expect(WORKSPACE_POLICY_DEFAULTS.captureTitles).toBe(false);
    expect(WORKSPACE_POLICY_DEFAULTS.captureUrls).toBe(false);
  });

  it('defaults screenshot retention to 60 days', () => {
    expect(WORKSPACE_POLICY_DEFAULTS.retentionDaysScreenshots).toBe(60);
  });

  it('defaults member tracking knobs to production values', () => {
    expect(WORKSPACE_POLICY_DEFAULTS.defaultScreenshotIntervalMin).toBe(180);
    expect(WORKSPACE_POLICY_DEFAULTS.defaultIdleThresholdMin).toBe(5);
  });
});

describe('PatchWorkspacePolicyRequest', () => {
  it('rejects an empty body', () => {
    const out = PatchWorkspacePolicyRequest.safeParse({});
    expect(out.success).toBe(false);
  });

  it('accepts a single-field patch', () => {
    const out = PatchWorkspacePolicyRequest.safeParse({ captureApps: true });
    expect(out.success).toBe(true);
  });

  it('rejects an out-of-range retentionDaysScreenshots', () => {
    const out = PatchWorkspacePolicyRequest.safeParse({ retentionDaysScreenshots: -1 });
    expect(out.success).toBe(false);
  });

  it('accepts retentionDaysScreenshots = 0 (no purge)', () => {
    const out = PatchWorkspacePolicyRequest.safeParse({ retentionDaysScreenshots: 0 });
    expect(out.success).toBe(true);
  });

  it('accepts workspace default tracking knobs inside member override ranges', () => {
    const out = PatchWorkspacePolicyRequest.safeParse({
      defaultScreenshotIntervalMin: 180,
      defaultIdleThresholdMin: 5,
    });
    expect(out.success).toBe(true);
  });

  it('rejects workspace default tracking knobs outside member override ranges', () => {
    expect(PatchWorkspacePolicyRequest.safeParse({ defaultScreenshotIntervalMin: 2 }).success).toBe(false);
    expect(PatchWorkspacePolicyRequest.safeParse({ defaultIdleThresholdMin: 0 }).success).toBe(false);
  });
});

describe('ActivitySampleInput (M14 fields)', () => {
  const base = {
    id: 'aaaaaaaaaaaaaaaaaaaaaaaaaa',
    bucketStart: '2026-06-03T10:00:00.000Z',
    keystrokes: 0,
    clicks: 0,
    mouseDistancePx: 0,
    scrollEvents: 0,
  };

  it('accepts a sample without any activeXxx fields (backward compat)', () => {
    expect(ActivitySampleInput.safeParse(base).success).toBe(true);
  });

  it('accepts activeApp + activeAppBundle', () => {
    const out = ActivitySampleInput.safeParse({ ...base, activeApp: 'VS Code', activeAppBundle: 'com.microsoft.VSCode' });
    expect(out.success).toBe(true);
  });

  it('rejects a title longer than 300 chars', () => {
    const out = ActivitySampleInput.safeParse({ ...base, activeTitle: 'x'.repeat(301) });
    expect(out.success).toBe(false);
  });

  it('rejects a URL longer than 2048 chars', () => {
    const out = ActivitySampleInput.safeParse({ ...base, activeUrl: 'https://example.com/' + 'x'.repeat(2050) });
    expect(out.success).toBe(false);
  });

  it('accepts nulls', () => {
    const out = ActivitySampleInput.safeParse({
      ...base,
      activeApp: null,
      activeAppBundle: null,
      activeTitle: null,
      activeUrl: null,
    });
    expect(out.success).toBe(true);
  });
});
