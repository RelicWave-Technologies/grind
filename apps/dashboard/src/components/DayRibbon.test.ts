import { describe, expect, it } from 'vitest';
import { instantForZonedDateTime } from '@grind/types';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DayInsight } from '../lib/types';
import { buildTimelineTicks, DayRibbon } from './DayRibbon';

describe('buildTimelineTicks', () => {
  it('places ticks on local three-hour boundaries in a half-hour-offset timezone', () => {
    const timeZone = 'Asia/Kolkata';
    const start = instantForZonedDateTime(
      { year: 2026, month: 7, day: 17, hour: 0, minute: 0, second: 0 },
      timeZone,
    ).getTime();
    const end = instantForZonedDateTime(
      { year: 2026, month: 7, day: 18, hour: 0, minute: 0, second: 0 },
      timeZone,
    ).getTime();

    const hours = buildTimelineTicks(start, end, timeZone).map(({ ms }) =>
      new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone,
      }).format(ms),
    );

    expect(hours).toEqual(['00:00', '03:00', '06:00', '09:00', '12:00', '15:00', '18:00', '21:00']);
  });

  it('marks a shift inside a full-day canvas without changing review blocks', () => {
    const day: DayInsight = {
      date: '2026-07-17',
      timezone: 'UTC',
      dayStart: Date.parse('2026-07-17T09:00:00Z'),
      dayEnd: Date.parse('2026-07-17T18:00:00Z'),
      isFuture: false,
      isToday: false,
      shift: null,
      firstActivityAt: null,
      lastActivityAt: null,
      totals: { workedMs: 0, meetingMs: 0, manualMs: 0, idleTrimmedMs: 0, pendingMs: 0, gapMs: 0 },
      blocks: [],
      recentRejected: [],
    };

    const html = renderToStaticMarkup(createElement(DayRibbon, {
      day,
      now: Date.parse('2026-07-18T00:00:00Z'),
      timeZone: 'UTC',
      displayWindow: {
        startedAt: Date.parse('2026-07-17T00:00:00Z'),
        endedAt: Date.parse('2026-07-18T00:00:00Z'),
      },
      markedWindow: {
        startedAt: day.dayStart,
        endedAt: day.dayEnd,
        label: 'General Shift · 09:00–18:00',
      },
    }));

    expect(html).toContain('ribbon-marked-window');
    expect(html).toContain('left:37.5%');
    expect(html).toContain('width:37.5%');
  });
});
