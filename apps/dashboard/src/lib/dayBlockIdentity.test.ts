import { describe, expect, it } from 'vitest';
import type { DayBlock } from './types';
import { dayBlockRowId } from './dayBlockIdentity';

const workBlock = (overrides: Partial<DayBlock> = {}): DayBlock => ({
  kind: 'WORK',
  startedAt: 1_000,
  endedAt: 2_000,
  durationMs: 1_000,
  timeEntryId: 'entry-1',
  ...overrides,
});

describe('dayBlockRowId', () => {
  it('distinguishes pause-resume segments belonging to one entry', () => {
    expect(dayBlockRowId(workBlock({ startedAt: 1_000, endedAt: 2_000 })))
      .not.toBe(dayBlockRowId(workBlock({ startedAt: 3_000, endedAt: 4_000 })));
  });

  it('does not change an open segment identity when only its end refreshes', () => {
    expect(dayBlockRowId(workBlock({ endedAt: 2_000 })))
      .toBe(dayBlockRowId(workBlock({ endedAt: 9_000 })));
  });

  it('keeps each non-entry block in its own stable namespace', () => {
    expect(dayBlockRowId(workBlock({ kind: 'GAP', timeEntryId: undefined })))
      .toBe('gap-1000-2000');
    expect(dayBlockRowId(workBlock({ kind: 'PENDING', requestId: 'request-1' })))
      .toBe('pending-request-1');
    expect(dayBlockRowId(workBlock({ kind: 'IDLE_TRIMMED', timeEntryId: undefined })))
      .toBe('idle-1000');
  });
});
