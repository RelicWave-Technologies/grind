import { describe, expect, it } from 'vitest';
import { canonicalTimerEntryPayload } from './timerLedger';

describe('canonicalTimerEntryPayload', () => {
  it('normalizes timestamp representations and segment order', () => {
    const first = canonicalTimerEntryPayload({
      id: 'entry',
      clientUuid: 'client',
      source: 'AUTO',
      revision: 2,
      startedAt: 1_000,
      endedAt: 3_000,
      closeReason: 'AGENT',
      segments: [
        { id: 'b', kind: 'MEETING', startedAt: 2_000, endedAt: 3_000 },
        { id: 'a', kind: 'WORK', startedAt: 1_000, endedAt: 2_000 },
      ],
    });
    const second = canonicalTimerEntryPayload({
      id: 'entry',
      clientUuid: 'client',
      larkTaskGuid: null,
      source: 'AUTO',
      revision: 2,
      startedAt: new Date(1_000),
      endedAt: new Date(3_000).toISOString(),
      closeReason: 'AGENT',
      segments: [
        { id: 'a', kind: 'WORK', startedAt: new Date(1_000), endedAt: new Date(2_000) },
        { id: 'b', kind: 'MEETING', startedAt: new Date(2_000).toISOString(), endedAt: 3_000 },
      ],
    });

    expect(second).toBe(first);
  });
});
