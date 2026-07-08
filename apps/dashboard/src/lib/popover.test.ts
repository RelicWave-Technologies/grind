import { describe, expect, it } from 'vitest';
import { computePopoverPosition } from './popover';

const trigger = (top: number, height = 32, left = 120, width = 160) => ({
  top,
  bottom: top + height,
  left,
  width,
  height,
});

describe('computePopoverPosition', () => {
  it('places the popover below the trigger when there is room', () => {
    expect(computePopoverPosition({
      trigger: trigger(120),
      popover: { width: 276, height: 220 },
      viewport: { width: 900, height: 700 },
      gap: 4,
      gutter: 8,
    })).toEqual({ top: 156, left: 120, flip: 'down' });
  });

  it('flips above the trigger near the bottom of the viewport', () => {
    const pos = computePopoverPosition({
      trigger: trigger(560, 32, 405),
      popover: { width: 276, height: 276 },
      viewport: { width: 859, height: 863 },
      gap: 4,
      gutter: 8,
    });

    expect(pos.flip).toBe('up');
    expect(pos.top).toBe(280);
    expect(pos.top + 276).toBeLessThanOrEqual(855);
  });

  it('clamps tall popovers inside the viewport instead of overflowing', () => {
    const pos = computePopoverPosition({
      trigger: trigger(300, 32),
      popover: { width: 276, height: 620 },
      viewport: { width: 900, height: 640 },
      gap: 4,
      gutter: 8,
    });

    expect(pos.top).toBe(12);
    expect(pos.top + 620).toBeLessThanOrEqual(632);
  });

  it('clamps horizontal position inside the viewport', () => {
    const pos = computePopoverPosition({
      trigger: trigger(120, 32, 760),
      popover: { width: 220, height: 180 },
      viewport: { width: 900, height: 700 },
      gap: 4,
      gutter: 8,
    });

    expect(pos.left).toBe(672);
    expect(pos.left + 220).toBeLessThanOrEqual(892);
  });
});
