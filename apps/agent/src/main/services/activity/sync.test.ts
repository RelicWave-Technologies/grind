import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivitySamplesRequest } from '@grind/types';

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../apiClient', () => ({ api: mocks.api }));
vi.mock('../../logger', () => ({ log: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const { flushActivity } = await import('./sync');

type Row = Record<string, unknown>;
function row(id: string, over: Row = {}): Row {
  return {
    id, timeEntryId: 't', bucketStart: 0, keystrokes: 1, clicks: 1, mouseDistancePx: 0,
    scrollEvents: 0, ikiCv: 0, moveSpeedCv: 0, pathStraightness: 0,
    activeApp: 'app', activeAppBundle: null, activeTitle: null, activeUrl: null, ...over,
  };
}
function fakeStore(rows: Row[]) {
  const synced: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store = { unsynced: (n: number) => rows.slice(0, n), markSynced: (ids: string[]) => synced.push(...ids) } as any;
  return { store, synced };
}
const bodyOf = () =>
  (mocks.api.mock.calls.find((call) => call[0] === '/v1/activity-samples')![1] as {
    body: {
      samples: Array<{
        id: string;
        activeApp: string | null;
        activeAppBundle: string | null;
        activeTitle: string | null;
        activeUrl: string | null;
      }>;
    };
  }).body;

afterEach(() => mocks.api.mockReset());
beforeEach(() => {
  mocks.api.mockImplementation(async (_path: string, options: { body: unknown }) => {
    // Keep the desktop's sender tested against the actual server wire schema.
    // This catches a client/server max-length drift before it can poison a
    // durable activity queue in production.
    ActivitySamplesRequest.parse(options.body);
    return { accepted: 1, detached: 0 };
  });
});

describe('flushActivity byte-bounded batching', () => {
  it('sends nothing when there is no backlog', async () => {
    const { store } = fakeStore([]);
    expect(await flushActivity(store)).toBe(0);
    expect(mocks.api).not.toHaveBeenCalled();
  });

  it('bounds the batch by bytes so the body never exceeds the API limit', async () => {
    const bigUrl = 'https://x/' + 'a'.repeat(2000); // ~2KB each → 500 rows would be ~1MB
    const rows = Array.from({ length: 500 }, (_, i) => row('r' + i, { activeUrl: bigUrl }));
    const { store, synced } = fakeStore(rows);

    const sent = await flushActivity(store);
    expect(Buffer.byteLength(JSON.stringify(bodyOf()))).toBeLessThan(64 * 1024); // under the server cap
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThan(500); // did not cram all 500 into one request
    expect(synced).toHaveLength(sent); // marked exactly what it sent, not the rest
  });

  it('truncates every metadata field to the shared API contract', async () => {
    const { store } = fakeStore([row('r1', {
      activeApp: 'a'.repeat(121),
      activeAppBundle: 'b'.repeat(201),
      activeTitle: 't'.repeat(301),
      activeUrl: 'u'.repeat(5000),
    })]);
    await flushActivity(store);
    const [sample] = bodyOf().samples;
    expect(sample!.activeApp!.length).toBe(120);
    expect(sample!.activeAppBundle!.length).toBe(200);
    expect(sample!.activeTitle!.length).toBe(300);
    expect(sample!.activeUrl!.length).toBe(2048);
  });

  it('always sends at least one sample even if it alone is large', async () => {
    const { store, synced } = fakeStore([row('r1', { activeUrl: 'u'.repeat(5000) })]);
    expect(await flushActivity(store)).toBe(1);
    expect(synced).toEqual(['r1']);
  });

  it('holds children whose timer parent has not been created yet', async () => {
    const { store, synced } = fakeStore([
      row('waiting', { timeEntryId: 'pending-parent' }),
      row('ready', { timeEntryId: 'created-parent', bucketStart: 60_000 }),
      row('unlinked', { timeEntryId: null, bucketStart: 120_000 }),
    ]);

    expect(await flushActivity(store, (entryId) => entryId === 'pending-parent')).toBe(2);

    const sent = bodyOf().samples as unknown as { id: string }[];
    expect(sent.map((sample) => sample.id)).toEqual(['ready', 'unlinked']);
    expect(synced).toEqual(['ready', 'unlinked']);
  });

  it('remains compatible with an older API response without detached count', async () => {
    mocks.api.mockResolvedValue({ accepted: 1 });
    const { store, synced } = fakeStore([row('r1')]);

    expect(await flushActivity(store)).toBe(1);
    expect(synced).toEqual(['r1']);
  });
});
