import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivitySamplesRequest } from '@grind/types';
import type * as ApiClientModule from '../apiClient';

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../apiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClientModule>()),
  api: mocks.api,
}));
vi.mock('../../logger', () => ({ log: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const { flushActivity } = await import('./sync');
const { HttpError } = await import('../apiClient');
const OWNER = { userId: 'u1', workspaceId: 'w1' };

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
  const store = {
    unsynced: (n: number) => rows.slice(0, n),
    markSynced: (sent: Array<{ id: string }>) => synced.push(...sent.map((r) => r.id)),
    claimUnowned: () => 0,
  } as unknown as Parameters<typeof flushActivity>[0];
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
    expect(await flushActivity(store, { owner: OWNER })).toBe(0);
    expect(mocks.api).not.toHaveBeenCalled();
  });

  it('bounds the batch by bytes so the body never exceeds the API limit', async () => {
    const bigUrl = 'https://x/' + 'a'.repeat(2000); // ~2KB each → 500 rows would be ~1MB
    const rows = Array.from({ length: 500 }, (_, i) => row('r' + i, { activeUrl: bigUrl }));
    const { store, synced } = fakeStore(rows);

    const sent = await flushActivity(store, { owner: OWNER });
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
    await flushActivity(store, { owner: OWNER });
    const [sample] = bodyOf().samples;
    expect(sample!.activeApp!.length).toBe(120);
    expect(sample!.activeAppBundle!.length).toBe(200);
    expect(sample!.activeTitle!.length).toBe(300);
    expect(sample!.activeUrl!.length).toBe(2048);
  });

  it('always sends at least one sample even if it alone is large', async () => {
    const { store, synced } = fakeStore([row('r1', { activeUrl: 'u'.repeat(5000) })]);
    expect(await flushActivity(store, { owner: OWNER })).toBe(1);
    expect(synced).toEqual(['r1']);
  });

  it('holds children whose timer parent has not been created yet', async () => {
    const { store, synced } = fakeStore([
      row('waiting', { timeEntryId: 'pending-parent' }),
      row('ready', { timeEntryId: 'created-parent', bucketStart: 60_000 }),
      row('unlinked', { timeEntryId: null, bucketStart: 120_000 }),
    ]);

    expect(await flushActivity(store, { owner: OWNER, isTimeEntryPendingCreate: (entryId) => entryId === 'pending-parent' })).toBe(2);

    const sent = bodyOf().samples as unknown as { id: string }[];
    expect(sent.map((sample) => sample.id)).toEqual(['ready', 'unlinked']);
    expect(synced).toEqual(['ready', 'unlinked']);
  });

  it('sends nothing when the signed-in account changed after the rows were read', async () => {
    const { store, synced } = fakeStore([row('r1')]);
    expect(await flushActivity(store, { owner: OWNER, stillOwner: async () => false })).toBe(0);
    expect(mocks.api).not.toHaveBeenCalled();
    expect(synced).toEqual([]);
  });

  it('marks synced with the rev it sent, and claims through the caller\'s once-per-owner hook', async () => {
    const marked: unknown[] = [];
    const claim = vi.fn();
    const store = {
      unsynced: () => [row('r1', { rev: 3 })],
      markSynced: (sent: unknown[]) => marked.push(...sent),
      claimUnowned: () => { throw new Error('per-flush claim must not run'); },
    } as unknown as Parameters<typeof flushActivity>[0];

    expect(await flushActivity(store, { owner: OWNER, claimUnowned: claim, stillOwner: async () => true })).toBe(1);
    expect(claim).toHaveBeenCalledWith(OWNER);
    expect(marked).toEqual([{ id: 'r1', rev: 3 }]);
  });

  it('sends nothing while signed out', async () => {
    const { store } = fakeStore([row('r1')]);
    expect(await flushActivity(store, { owner: null })).toBe(0);
    expect(mocks.api).not.toHaveBeenCalled();
  });

  it('remains compatible with an older API response without detached count', async () => {
    mocks.api.mockResolvedValue({ accepted: 1 });
    const { store, synced } = fakeStore([row('r1')]);

    expect(await flushActivity(store, { owner: OWNER })).toBe(1);
    expect(synced).toEqual(['r1']);
  });
});

describe('capping a title that ends in an emoji', () => {
  /** U+1F600 is one character stored as TWO UTF-16 code units. Putting it at
   *  the 300-character boundary makes the cut land inside it. */
  const withEmojiAtTheCut = `${'a'.repeat(299)}\u{1F600}tail`;

  it('does not leave half an emoji behind', async () => {
    const { store } = fakeStore([row('r1', { activeTitle: withEmojiAtTheCut })]);
    await flushActivity(store, { owner: OWNER });
    const title = bodyOf().samples[0]!.activeTitle!;

    // A trailing high surrogate is what Postgres rejects with "unexpected end
    // of hex escape", losing every other sample in the batch with it.
    const last = title.charCodeAt(title.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    expect(Buffer.from(title, 'utf8').toString('utf8')).toBe(title);
    expect(title.length).toBe(299);
  });

  it('leaves an emoji that fits completely alone', async () => {
    const fits = 'Slack \u{1F600} general';
    const { store } = fakeStore([row('r1', { activeTitle: fits })]);
    await flushActivity(store, { owner: OWNER });
    expect(bodyOf().samples[0]!.activeTitle).toBe(fits);
  });
});

describe('a sample the API refuses', () => {
  function storeWithQuarantine(rows: Row[]) {
    const synced: string[] = [];
    const quarantined: string[] = [];
    const store = {
      unsynced: (n: number) => rows.slice(0, n),
      markSynced: (sent: Array<{ id: string }>) => synced.push(...sent.map((r) => r.id)),
      quarantine: (id: string) => quarantined.push(id),
      claimUnowned: () => 0,
    } as unknown as Parameters<typeof flushActivity>[0];
    return { store, synced, quarantined };
  }

  it('splits the batch, quarantines only the bad sample, and syncs the rest', async () => {
    mocks.api.mockImplementation(async (_path: string, options: { body: { samples: Array<{ id: string }> } }) => {
      if (options.body.samples.some((s) => s.id === 'bad')) {
        throw new HttpError('/v1/activity-samples', 400, '{"error":"validation_failed"}');
      }
      return { accepted: options.body.samples.length, detached: 0 };
    });
    const rows = ['a', 'b', 'bad', 'c', 'd'].map((id, i) => row(id, { bucketStart: i * 60_000 }));
    const { store, synced, quarantined } = storeWithQuarantine(rows);

    expect(await flushActivity(store, { owner: OWNER })).toBe(5);
    expect(quarantined).toEqual(['bad']);
    expect(synced.sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps everything queued when the failure is not a refusal of the body', async () => {
    mocks.api.mockRejectedValue(new HttpError('/v1/activity-samples', 503, 'down'));
    const { store, synced, quarantined } = storeWithQuarantine([row('a'), row('b', { bucketStart: 60_000 })]);

    await expect(flushActivity(store, { owner: OWNER })).rejects.toThrow('503');
    expect(synced).toEqual([]);
    expect(quarantined).toEqual([]);
    expect(mocks.api).toHaveBeenCalledTimes(1);
  });
});
