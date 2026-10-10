import { describe, expect, it } from 'vitest';
import { countdownAnnouncement } from './promptA11y';

describe('countdownAnnouncement', () => {
  it('announces the start, whatever the number', () => {
    expect(countdownAnnouncement(27, true)).toBe('27 seconds left');
  });

  it('stays quiet between the ten-second marks', () => {
    const spoken: string[] = [];
    for (let s = 29; s > 0; s -= 1) {
      const text = countdownAnnouncement(s, false);
      if (text) spoken.push(text);
    }
    expect(spoken).toEqual(['20 seconds left', '10 seconds left']);
  });

  it('says nothing once the countdown has run out', () => {
    expect(countdownAnnouncement(0, false)).toBeNull();
    expect(countdownAnnouncement(0, true)).toBeNull();
  });
});
