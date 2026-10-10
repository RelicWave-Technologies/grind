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

  it('hashes a fractional agent timestamp the same as the server copy of it', () => {
    const agent = canonicalTimerEntryPayload({
      id: 'entry',
      clientUuid: 'client',
      source: 'AUTO',
      revision: 3,
      startedAt: 1787573214428.37,
      endedAt: null,
      closeReason: null,
      segments: [{ id: 'a', kind: 'WORK', startedAt: 1787573214428.37, endedAt: null }],
    });
    // What the server stored: the agent sent ISO strings, and Date truncates.
    const startedAt = new Date(1787573214428.37).toISOString();
    const server = canonicalTimerEntryPayload({
      id: 'entry',
      clientUuid: 'client',
      source: 'AUTO',
      revision: 3,
      startedAt,
      endedAt: null,
      closeReason: null,
      segments: [{ id: 'a', kind: 'WORK', startedAt, endedAt: null }],
    });

    expect(agent).toBe(server);
  });

  it('leaves zero-length segments out, the way the server stores the entry', () => {
    const base = {
      id: 'entry',
      clientUuid: 'client',
      source: 'AUTO' as const,
      revision: 4,
      startedAt: 1_000,
      endedAt: 5_000,
      closeReason: 'AGENT' as const,
    };
    const local = canonicalTimerEntryPayload({
      ...base,
      segments: [
        { id: 'z', kind: 'WORK', startedAt: 1_000, endedAt: 1_000 },
        { id: 'sub', kind: 'WORK', startedAt: 2_000.1, endedAt: 2_000.8 },
        { id: 'a', kind: 'WORK', startedAt: 3_000, endedAt: 5_000 },
      ],
    });
    const stored = canonicalTimerEntryPayload({
      ...base,
      segments: [{ id: 'a', kind: 'WORK', startedAt: 3_000, endedAt: 5_000 }],
    });
    expect(local).toBe(stored);
  });
});
