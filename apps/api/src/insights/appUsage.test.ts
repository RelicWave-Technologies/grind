import { describe, it, expect } from 'vitest';
import { buildAppUsage } from './appUsage';

const s = (
  activeApp: string | null,
  activeAppBundle: string | null = null,
  keystrokes = 0,
  clicks = 0,
) => ({ activeApp, activeAppBundle, keystrokes, clicks });

describe('buildAppUsage', () => {
  it('returns empty when no samples', () => {
    const out = buildAppUsage([]);
    expect(out).toEqual({ totalMinutes: 0, topApps: [] });
  });

  it('ignores samples with no activeApp (policy-scrubbed)', () => {
    const out = buildAppUsage([s(null), s(null), s(null)]);
    expect(out.totalMinutes).toBe(0);
    expect(out.topApps).toHaveLength(0);
  });

  it('aggregates minutes + counts per (app, bundle) tuple', () => {
    const out = buildAppUsage([
      s('Chrome', 'com.google.Chrome', 5, 1),
      s('Chrome', 'com.google.Chrome', 3, 2),
      s('VS Code', 'com.microsoft.VSCode', 8, 0),
    ]);
    expect(out.totalMinutes).toBe(3);
    expect(out.topApps).toEqual([
      { app: 'Chrome', appBundle: 'com.google.Chrome', minutes: 2, keystrokes: 8, clicks: 3 },
      { app: 'VS Code', appBundle: 'com.microsoft.VSCode', minutes: 1, keystrokes: 8, clicks: 0 },
    ]);
  });

  it('sorts by minutes desc; tie-breaks on keystrokes; then app name', () => {
    const out = buildAppUsage([
      s('A', null, 0),
      s('B', null, 5),
      s('C', null, 3),
    ]);
    // All three have 1 minute → tie-break on keystrokes (5 > 3 > 0): B, C, A.
    expect(out.topApps.map((a) => a.app)).toEqual(['B', 'C', 'A']);
  });

  it('same display name + different bundle stay separate', () => {
    const out = buildAppUsage([
      s('Chrome', 'com.google.Chrome'),
      s('Chrome', 'com.google.Chrome.canary'),
      s('Chrome', 'com.google.Chrome.canary'),
    ]);
    expect(out.topApps).toHaveLength(2);
    expect(out.topApps[0]).toMatchObject({ app: 'Chrome', appBundle: 'com.google.Chrome.canary', minutes: 2 });
    expect(out.topApps[1]).toMatchObject({ app: 'Chrome', appBundle: 'com.google.Chrome', minutes: 1 });
  });

  it('respects topN cap', () => {
    const samples = Array.from({ length: 15 }, (_, i) => s(`App${i}`));
    const out = buildAppUsage(samples, 5);
    expect(out.topApps).toHaveLength(5);
    expect(out.totalMinutes).toBe(15);
  });

  it('handles a bundle-only entry', () => {
    const out = buildAppUsage([s('Slack', null, 10, 5)]);
    expect(out.topApps).toEqual([
      { app: 'Slack', appBundle: null, minutes: 1, keystrokes: 10, clicks: 5 },
    ]);
  });

  it('mixed populated + null samples — null skipped', () => {
    const out = buildAppUsage([s('Chrome'), s(null), s('Chrome'), s(null)]);
    expect(out.totalMinutes).toBe(2);
    expect(out.topApps[0]?.minutes).toBe(2);
  });
});
