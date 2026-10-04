import { describe, expect, it } from 'vitest';
import { FloatingBarVisibilityPolicy } from './floatingBarVisibility';

describe('FloatingBarVisibilityPolicy', () => {
  it('stays visible while the same entry changes from accruing to paused', () => {
    const policy = new FloatingBarVisibilityPolicy();

    expect(policy.syncTimer('entry-1', true)).toBe(true);
    expect(policy.syncTimer('entry-1', true)).toBe(true);
  });

  it('dismisses only the current entry and restores for the next entry', () => {
    const policy = new FloatingBarVisibilityPolicy();

    expect(policy.syncTimer('entry-1', true)).toBe(true);
    expect(policy.dismissCurrent()).toBe(false);
    expect(policy.syncTimer('entry-1', true)).toBe(false);
    expect(policy.syncTimer(null, true)).toBe(false);
    expect(policy.syncTimer('entry-2', true)).toBe(true);
  });

  it('keeps the Settings preference authoritative and lets explicit enable restore the bar', () => {
    const policy = new FloatingBarVisibilityPolicy();

    expect(policy.syncTimer('entry-1', false)).toBe(false);
    expect(policy.setPreferenceVisible(true)).toBe(true);
    expect(policy.dismissCurrent()).toBe(false);
    expect(policy.setPreferenceVisible(true)).toBe(true);
    expect(policy.setPreferenceVisible(false)).toBe(false);
  });
});
