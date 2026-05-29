import { describe, it, expect } from 'vitest';
import {
  scoreMinute,
  scoreDay,
  minuteIntensity,
  isIdleMinute,
  FULL_CREDIT,
  READING_CREDIT,
  type MinuteActivity,
} from './score';
import { presetFor, ROLE_PRESETS } from './presets';

const zero: MinuteActivity = { keystrokes: 0, clicks: 0, scrollEvents: 0, mouseDistancePx: 0 };
const m = (over: Partial<MinuteActivity>): MinuteActivity => ({ ...zero, ...over });

describe('isIdleMinute', () => {
  it('is idle with no input', () => {
    expect(isIdleMinute(zero)).toBe(true);
  });
  it('tiny mouse jitter under threshold is still idle', () => {
    expect(isIdleMinute(m({ mouseDistancePx: 40 }))).toBe(true);
  });
  it('any keystroke / click / scroll / real movement is not idle', () => {
    expect(isIdleMinute(m({ keystrokes: 1 }))).toBe(false);
    expect(isIdleMinute(m({ clicks: 1 }))).toBe(false);
    expect(isIdleMinute(m({ scrollEvents: 1 }))).toBe(false);
    expect(isIdleMinute(m({ mouseDistancePx: 500 }))).toBe(false);
  });
});

describe('minuteIntensity', () => {
  const dev = presetFor('DEVELOPER');

  it('is 0 for an idle minute', () => {
    expect(minuteIntensity(zero, dev)).toBe(0);
  });

  it('saturates at 1 when every channel meets its saturation', () => {
    const sat = m({ keystrokes: 300, clicks: 60, scrollEvents: 40, mouseDistancePx: 6000 });
    expect(minuteIntensity(sat, dev)).toBeCloseTo(1, 5);
  });

  it('clamps channels above saturation (no >1 credit for spamming one channel)', () => {
    const spam = m({ keystrokes: 100000 });
    // only the keystroke weight (0.5) contributes, clamped to 1
    expect(minuteIntensity(spam, dev)).toBeCloseTo(0.5, 5);
  });

  it('weights channels per the role preset', () => {
    // half-saturation on keystrokes only → 0.5 * weight
    const half = m({ keystrokes: 150 });
    expect(minuteIntensity(half, dev)).toBeCloseTo(0.5 * dev.weight.keystrokes, 5);
  });

  it('every preset has weights summing to 1', () => {
    for (const preset of Object.values(ROLE_PRESETS)) {
      const sum = Object.values(preset.weight).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 6);
    }
  });

  it('role changes the score for the same activity (designer rewards mouse)', () => {
    const mouseHeavy = m({ mouseDistancePx: 12000, clicks: 120 });
    const dev2 = minuteIntensity(mouseHeavy, presetFor('DEVELOPER'));
    const des = minuteIntensity(mouseHeavy, presetFor('DESIGNER'));
    expect(des).toBeGreaterThan(dev2);
  });
});

describe('scoreMinute classification', () => {
  it('idle minute scores 0', () => {
    expect(scoreMinute(zero, { role: 'DEVELOPER' })).toBe(0);
  });

  it('protected meeting minute gets full credit even with no input', () => {
    expect(scoreMinute(zero, { role: 'DEVELOPER', ctx: { isProtectedMeeting: true } })).toBe(FULL_CREDIT);
  });

  it('protected meeting beats idle classification (meeting wins)', () => {
    expect(scoreMinute(m({ keystrokes: 0 }), { ctx: { isProtectedMeeting: true } })).toBe(1);
  });

  it('low input but scrolling gets reading credit', () => {
    const reading = m({ scrollEvents: 20 }); // intensity is low, scroll is clearly present
    expect(scoreMinute(reading, { role: 'DEVELOPER' })).toBe(READING_CREDIT);
  });

  it('does not downgrade a high-intensity minute to reading credit', () => {
    const busy = m({ keystrokes: 300, clicks: 60, scrollEvents: 40, mouseDistancePx: 6000 });
    expect(scoreMinute(busy, { role: 'DEVELOPER' })).toBeGreaterThan(READING_CREDIT);
  });

  it('defaults to the OTHER preset when role is missing', () => {
    const a = scoreMinute(m({ keystrokes: 100 }), {});
    const b = scoreMinute(m({ keystrokes: 100 }), { role: 'OTHER' });
    expect(a).toBe(b);
  });
});

describe('scoreDay', () => {
  it('returns a zeroed result for an empty day (no divide-by-zero)', () => {
    expect(scoreDay([])).toEqual({
      score: 0,
      trackedMinutes: 0,
      engagedMinutes: 0,
      protectedMinutes: 0,
      idleMinutes: 0,
      avgIntensity: 0,
    });
  });

  it('a fully-saturated hour scores 100', () => {
    const busy = { keystrokes: 300, clicks: 60, scrollEvents: 40, mouseDistancePx: 6000 };
    const day = Array.from({ length: 60 }, () => ({ ...busy }));
    const r = scoreDay(day, { role: 'DEVELOPER' });
    expect(r.score).toBe(100);
    expect(r.engagedMinutes).toBe(60);
    expect(r.idleMinutes).toBe(0);
  });

  it('half-idle half-busy lands around half', () => {
    const busy = { keystrokes: 300, clicks: 60, scrollEvents: 40, mouseDistancePx: 6000 };
    const day = [
      ...Array.from({ length: 30 }, () => ({ ...busy })),
      ...Array.from({ length: 30 }, () => ({ ...zero })),
    ];
    const r = scoreDay(day, { role: 'DEVELOPER' });
    expect(r.score).toBe(50);
    expect(r.engagedMinutes).toBe(30);
    expect(r.idleMinutes).toBe(30);
  });

  it('counts protected meeting minutes separately and credits them', () => {
    const day = [
      { ...zero, isProtectedMeeting: true },
      { ...zero, isProtectedMeeting: true },
      { ...zero }, // idle
    ];
    const r = scoreDay(day, { role: 'DEVELOPER' });
    expect(r.protectedMinutes).toBe(2);
    expect(r.idleMinutes).toBe(1);
    expect(r.engagedMinutes).toBe(0);
    // 2 of 3 minutes at full credit → 67
    expect(r.score).toBe(67);
  });

  it('avgIntensity ignores idle and protected minutes', () => {
    const half = { keystrokes: 150 }; // half-sat keystrokes only
    const day = [{ ...zero, ...half }, { ...zero }, { ...zero, isProtectedMeeting: true }];
    const r = scoreDay(day, { role: 'DEVELOPER' });
    expect(r.engagedMinutes).toBe(1);
    expect(r.avgIntensity).toBeCloseTo(0.5 * presetFor('DEVELOPER').weight.keystrokes, 5);
  });
});
