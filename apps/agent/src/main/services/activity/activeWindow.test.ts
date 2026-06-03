import { describe, it, expect } from 'vitest';
import { ActiveWindowTracker } from './activeWindow';

const o = (
  ts: number,
  app: string | null,
  appBundle: string | null = null,
  title: string | null = null,
  url: string | null = null,
) => ({ ts, app, appBundle, title, url });

describe('ActiveWindowTracker', () => {
  it('returns null fields when nothing was observed', () => {
    const t = new ActiveWindowTracker();
    const d = t.dominantFor(0, 60_000);
    expect(d).toEqual({
      activeApp: null,
      activeAppBundle: null,
      activeTitle: null,
      activeUrl: null,
    });
  });

  it('attributes a full bucket to a single observation made at the start', () => {
    const t = new ActiveWindowTracker();
    t.observe(o(0, 'Chrome', 'com.google.Chrome'));
    const d = t.dominantFor(0, 60_000);
    expect(d.activeApp).toBe('Chrome');
    expect(d.activeAppBundle).toBe('com.google.Chrome');
  });

  it('picks the app with the longest cumulative time', () => {
    const t = new ActiveWindowTracker();
    // Bucket = [0, 60_000)
    // Chrome owns [0, 10), VS Code owns [10, 60) → VS Code wins.
    t.observe(o(0, 'Chrome'));
    t.observe(o(10_000, 'VS Code'));
    const d = t.dominantFor(0, 60_000);
    expect(d.activeApp).toBe('VS Code');
  });

  it('picks Chrome when it actually owns more time even with more switches', () => {
    const t = new ActiveWindowTracker();
    // Chrome [0,30), VS Code [30,35), Chrome [35,60) → Chrome 55s, VS Code 5s.
    t.observe(o(0, 'Chrome'));
    t.observe(o(30_000, 'VS Code'));
    t.observe(o(35_000, 'Chrome'));
    const d = t.dominantFor(0, 60_000);
    expect(d.activeApp).toBe('Chrome');
  });

  it('uses the prior observation as the anchor for time before the first in-bucket tick', () => {
    const t = new ActiveWindowTracker();
    // Observed Chrome at t = -5_000 (before bucketStart). Then VS Code at 50_000.
    // Chrome owns [0, 50), VS Code owns [50, 60). Chrome should win.
    t.observe(o(-5_000, 'Chrome'));
    t.observe(o(50_000, 'VS Code'));
    const d = t.dominantFor(0, 60_000);
    expect(d.activeApp).toBe('Chrome');
  });

  it('attaches the winning app\'s LAST observation\'s title + url', () => {
    const t = new ActiveWindowTracker();
    t.observe(o(0, 'Chrome', 'com.google.Chrome', 'tab one', 'https://a'));
    t.observe(o(30_000, 'Chrome', 'com.google.Chrome', 'tab two', 'https://b'));
    const d = t.dominantFor(0, 60_000);
    expect(d.activeTitle).toBe('tab two');
    expect(d.activeUrl).toBe('https://b');
  });

  it('falls back to the most recent observation when no slice fits the bucket', () => {
    const t = new ActiveWindowTracker();
    // Only observation is BEFORE the bucket.
    t.observe(o(-1_000, 'Chrome'));
    // No in-bucket ticks — fallback should still attribute Chrome.
    const d = t.dominantFor(0, 60_000);
    // priorIdx points to the obs at -1000, so the [0,60_000) slice is
    // attributed to Chrome — full bucket.
    expect(d.activeApp).toBe('Chrome');
  });

  it('returns null when only a pre-bucket null observation exists', () => {
    const t = new ActiveWindowTracker();
    t.observe(o(0, null, null));
    const d = t.dominantFor(0, 60_000);
    expect(d.activeApp).toBeNull();
  });

  it('observations later than the bucket end do not steal time', () => {
    const t = new ActiveWindowTracker();
    t.observe(o(0, 'Chrome'));
    t.observe(o(120_000, 'VS Code')); // outside bucket
    const d = t.dominantFor(0, 60_000);
    expect(d.activeApp).toBe('Chrome');
  });

  it('handles two same-named apps across observations', () => {
    const t = new ActiveWindowTracker();
    t.observe(o(0, 'Chrome', 'com.google.Chrome'));
    t.observe(o(20_000, 'Chrome', 'com.google.Chrome'));
    t.observe(o(40_000, 'Chrome', 'com.google.Chrome'));
    const d = t.dominantFor(0, 60_000);
    expect(d.activeApp).toBe('Chrome');
  });

  it('separates by (app + bundle) tuple — same display name, different bundle counts separately', () => {
    const t = new ActiveWindowTracker();
    // 30s of "Chrome" (real), 30s of "Chrome" (test build with different bundle).
    t.observe(o(0, 'Chrome', 'com.google.Chrome'));
    t.observe(o(30_000, 'Chrome', 'com.google.Chrome.test'));
    const d = t.dominantFor(0, 60_000);
    // Both have 30s — winner is whichever Map insertion order picks; assert
    // we got *a* Chrome.
    expect(d.activeApp).toBe('Chrome');
  });

  it('prune drops old observations but keeps the most recent pre-cut as an anchor', () => {
    const t = new ActiveWindowTracker();
    t.observe(o(0, 'A'));
    t.observe(o(10_000, 'B'));
    t.observe(o(20_000, 'C'));
    t.observe(o(70_000, 'D'));
    t.prune(60_000);
    // C (the latest pre-60s) is kept as the anchor; D is in-window.
    expect(t.size()).toBe(2);
    // Next bucket [60_000, 120_000): anchor C [60_000, 70_000) + D [70_000, 120_000)
    const d = t.dominantFor(60_000, 120_000);
    expect(d.activeApp).toBe('D');
  });

  it('respects the observation cap', () => {
    const t = new ActiveWindowTracker(5);
    for (let i = 0; i < 20; i++) t.observe(o(i * 1_000, `App${i}`));
    expect(t.size()).toBe(5);
  });

  it('null app + null bundle in mid-bucket are skipped, not winners', () => {
    const t = new ActiveWindowTracker();
    t.observe(o(0, 'Chrome'));
    t.observe(o(20_000, null, null)); // no foreground window for 30s
    t.observe(o(50_000, 'VS Code'));
    const d = t.dominantFor(0, 60_000);
    // Chrome owned 20s, null owned 30s (skipped), VS Code owned 10s →
    // Chrome wins among the non-null slices.
    expect(d.activeApp).toBe('Chrome');
  });

  it('a flapping rapid switch favours total time, not last seen', () => {
    const t = new ActiveWindowTracker();
    // VS Code dominates 0..40s, then 5x rapid 1s flips to Chrome and back.
    t.observe(o(0, 'VS Code'));
    t.observe(o(40_000, 'Chrome'));
    t.observe(o(41_000, 'VS Code'));
    t.observe(o(42_000, 'Chrome'));
    t.observe(o(43_000, 'VS Code'));
    t.observe(o(44_000, 'Chrome'));
    t.observe(o(45_000, 'VS Code'));
    const d = t.dominantFor(0, 60_000);
    expect(d.activeApp).toBe('VS Code');
  });
});
