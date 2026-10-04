import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { localDayWindowInTimeZone } from '@grind/types';
import DayTimeline, { buildTimelineTicks } from './DayTimeline';

const TIME_ZONE = 'Asia/Kolkata';
const DAY = localDayWindowInTimeZone('2026-07-17', TIME_ZONE)!;

describe('DayTimeline', () => {
  it('uses true workspace-local three-hour tick boundaries', () => {
    const labels = buildTimelineTicks(DAY.start.getTime(), DAY.end.getTime(), TIME_ZONE)
      .map((value) => new Intl.DateTimeFormat('en-GB', {
        timeZone: TIME_ZONE,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(value));

    expect(labels).toEqual(['00:00', '03:00', '06:00', '09:00', '12:00', '15:00', '18:00', '21:00']);
  });

  it('marks the shift inside the full-day canvas without changing entries', () => {
    const shiftStart = new Date('2026-07-17T09:00:00+05:30').getTime();
    const shiftEnd = new Date('2026-07-17T18:00:00+05:30').getTime();
    const html = renderToStaticMarkup(
      <DayTimeline
        entries={[]}
        now={new Date('2026-07-17T12:00:00+05:30').getTime()}
        dayStart={DAY.start.getTime()}
        dayEnd={DAY.end.getTime()}
        timeZone={TIME_ZONE}
        markedWindow={{ startedAt: shiftStart, endedAt: shiftEnd, label: 'Day · 09:00–18:00' }}
      />,
    );

    expect(html).toContain('class="dt-marked-window"');
    expect(html).toContain('left:37.5%');
    expect(html).toContain('width:37.5%');
  });

  it('renders approved manual entries with the manual timeline treatment', () => {
    const startedAt = new Date('2026-07-17T06:00:00+05:30').getTime();
    const endedAt = new Date('2026-07-17T07:00:00+05:30').getTime();
    const html = renderToStaticMarkup(
      <DayTimeline
        entries={[{
          id: 'manual-entry',
          source: 'MANUAL',
          larkTaskGuid: null,
          segments: [{ kind: 'WORK', startedAt, endedAt }],
        }]}
        now={new Date('2026-07-17T12:00:00+05:30').getTime()}
        dayStart={DAY.start.getTime()}
        dayEnd={DAY.end.getTime()}
        timeZone={TIME_ZONE}
      />,
    );

    expect(html).toContain('dt-seg-manual');
    expect(html).toContain('Manual · 6:00 AM – 7:00 AM');
  });
});
