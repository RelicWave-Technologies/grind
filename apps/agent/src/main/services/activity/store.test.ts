import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { ActivityStore, type ActivityRow } from './store';
import { activityPercent } from './percent';

class FakeDb {
  statements: string[] = [];

  exec(): void {
    // Schema setup is not under test here.
  }

  prepare(sql: string): { run: () => { changes: number } } {
    this.statements.push(sql);
    return { run: vi.fn(() => ({ changes: 7 })) };
  }
}

describe('ActivityStore.scrubActiveFields', () => {
  it('scrubs every active-window column when app capture is off', () => {
    const db = new FakeDb();
    const store = new ActivityStore(db as never);

    const changed = store.scrubActiveFields({ captureApps: false, captureTitles: false, captureUrls: false });

    expect(changed).toBe(7);
    expect(db.statements.at(-1)).toBe(
      'UPDATE activity_samples SET active_app = NULL, active_app_bundle = NULL, active_title = NULL, active_url = NULL',
    );
  });

  it('keeps app fields while scrubbing disabled title and URL fields', () => {
    const db = new FakeDb();
    const store = new ActivityStore(db as never);

    const changed = store.scrubActiveFields({ captureApps: true, captureTitles: false, captureUrls: false });

    expect(changed).toBe(7);
    expect(db.statements.at(-1)).toBe('UPDATE activity_samples SET active_title = NULL, active_url = NULL');
  });

  it('does nothing when all capture fields are enabled', () => {
    const db = new FakeDb();
    const store = new ActivityStore(db as never);
    const before = db.statements.length;

    const changed = store.scrubActiveFields({ captureApps: true, captureTitles: true, captureUrls: true });

    expect(changed).toBe(0);
    expect(db.statements).toHaveLength(before);
  });
});

describe('ActivityStore on a real database', () => {
  const OWNER = { userId: 'u1', workspaceId: 'w1' };

  const minute = (bucketStart: number, over: Partial<ActivityRow> = {}): ActivityRow => ({
    id: `s-${bucketStart}-${Math.random()}`,
    timeEntryId: 'e1',
    bucketStart,
    keystrokes: 0,
    clicks: 0,
    mouseDistancePx: 0,
    scrollEvents: 0,
    ikiCv: null,
    moveSpeedCv: null,
    pathStraightness: null,
    activeApp: null,
    activeAppBundle: null,
    activeTitle: null,
    activeUrl: null,
    synced: 0,
    ownerUserId: OWNER.userId,
    ownerWorkspaceId: OWNER.workspaceId,
    ...over,
  });

  const withLocalEntries = () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE local_entries (
      id TEXT PRIMARY KEY, sync_state TEXT NOT NULL, owner_user_id TEXT, owner_workspace_id TEXT
    )`);
    return db;
  };

  it('adds the tail of a minute to the head already stored — same row, back on the queue', () => {
    const store = new ActivityStore(new Database(':memory:'));
    store.persistMinute(minute(60_000, { keystrokes: 3, clicks: 1, ikiCv: 0.4 }));
    const [head] = store.unsynced(10, OWNER);
    store.markSynced([head!]);

    store.persistMinute(minute(60_000, { keystrokes: 5, clicks: 2, ikiCv: 0.7 }));

    const rows = store.unsynced(10, OWNER);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: head!.id, keystrokes: 8, clicks: 3, ikiCv: 0.7 });
  });

  it('does not mark a minute synced when its tail was merged in while the sync was in flight', () => {
    const store = new ActivityStore(new Database(':memory:'));
    store.persistMinute(minute(60_000, { keystrokes: 3 }));
    const sent = store.unsynced(10, OWNER); // read for the request
    store.persistMinute(minute(60_000, { keystrokes: 4 })); // the tail lands mid-request

    expect(store.markSynced(sent)).toBe(0);
    const [queued] = store.unsynced(10, OWNER);
    expect(queued).toMatchObject({ keystrokes: 7 });
    // The resend of the new total is marked normally.
    expect(store.markSynced([queued!])).toBe(1);
    expect(store.unsynced(10, OWNER)).toHaveLength(0);
  });

  it('quarantines a refused minute out of the queue until its minute changes again', () => {
    const store = new ActivityStore(new Database(':memory:'));
    store.persistMinute(minute(60_000, { keystrokes: 3 }));
    const [bad] = store.unsynced(10, OWNER);
    store.quarantine(bad!.id);
    expect(store.unsynced(10, OWNER)).toHaveLength(0);

    store.persistMinute(minute(60_000, { keystrokes: 1 })); // a tail: the minute is re-sent with its total
    expect(store.unsynced(10, OWNER)).toMatchObject([{ id: bad!.id, keystrokes: 4 }]);
  });

  it('prunes only synced minutes older than the cutoff', () => {
    const db = new Database(':memory:');
    const store = new ActivityStore(db);
    store.insert(minute(1_000, { id: 'old-synced' }));
    store.insert(minute(2_000, { id: 'old-unsynced' }));
    store.insert(minute(9_000, { id: 'new-synced' }));
    db.prepare(`UPDATE activity_samples SET synced = 1 WHERE id IN ('old-synced', 'new-synced')`).run();

    expect(store.pruneSynced(5_000)).toBe(1);
    const ids = (db.prepare('SELECT id FROM activity_samples ORDER BY id').all() as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual(['new-synced', 'old-unsynced']);
  });

  it('a quiet tail leaves a stored minute (and its sync state) alone', () => {
    const store = new ActivityStore(new Database(':memory:'));
    store.persistMinute(minute(60_000, { keystrokes: 3 }));
    store.markSynced(store.unsynced(10, OWNER));
    expect(store.persistMinute(minute(60_000))).toBe(false);
    expect(store.unsynced(10, OWNER)).toHaveLength(0);
  });

  it('skips samples of an entry still being created in SQL, so they never stall the queue', () => {
    const db = withLocalEntries();
    db.prepare(`INSERT INTO local_entries VALUES ('waiting', 'pending_create', 'u1', 'w1'), ('ready', 'synced', 'u1', 'w1')`).run();
    const store = new ActivityStore(db);
    for (let i = 0; i < 600; i++) store.insert(minute(i * 60_000, { timeEntryId: 'waiting' }));
    store.insert(minute(700 * 60_000, { timeEntryId: 'ready', keystrokes: 1 }));
    store.insert(minute(701 * 60_000, { timeEntryId: null, keystrokes: 1 }));

    const batch = store.unsynced(500, OWNER);
    expect(batch.map((r) => r.timeEntryId)).toEqual(['ready', null]);
  });

  it('syncs and sums only the signed-in account\'s samples; claims legacy ones through owned entries', () => {
    const db = withLocalEntries();
    db.prepare(`INSERT INTO local_entries VALUES ('e1', 'synced', 'u1', 'w1'), ('e9', 'synced', 'u9', 'w1')`).run();
    const store = new ActivityStore(db);
    store.insert(minute(0, { keystrokes: 10 }));
    store.insert(minute(60_000, { keystrokes: 7, ownerUserId: 'u9', ownerWorkspaceId: 'w1', timeEntryId: 'e9' }));
    store.insert(minute(120_000, { keystrokes: 4, ownerUserId: null, ownerWorkspaceId: null, timeEntryId: 'e1' }));
    store.insert(minute(180_000, { keystrokes: 2, ownerUserId: null, ownerWorkspaceId: null, timeEntryId: 'e9' }));

    expect(store.unsynced(10, OWNER).map((r) => r.keystrokes)).toEqual([10]);
    expect(store.claimUnowned(OWNER)).toBe(1);
    expect(store.unsynced(10, OWNER).map((r) => r.keystrokes)).toEqual([10, 4]);
    expect(store.countSince(0, OWNER).keystrokes).toBe(14);
    expect(store.aggregate(0, 240_000, OWNER)).toMatchObject({ minutes: 2, keystrokes: 14 });
  });

  it('zero minutes count toward the window, so a quiet stretch reads low', () => {
    const store = new ActivityStore(new Database(':memory:'));
    store.persistMinute(minute(0, { keystrokes: 120 }));
    for (let m = 1; m < 4; m++) store.persistMinute(minute(m * 60_000));
    const totals = store.aggregate(0, 4 * 60_000, OWNER);
    expect(totals.minutes).toBe(4);
    expect(activityPercent(totals).keyboard).toBe(25);
  });

  it('requeues only the owner\'s minutes in a range for a resend, and counts what is left', () => {
    const db = new Database(':memory:');
    const store = new ActivityStore(db);
    const OTHER = { userId: 'u2', workspaceId: 'w1' };
    store.insert(minute(1_000));
    store.insert(minute(2_000));
    store.insert(minute(5_000));
    store.insert(minute(2_000, { ownerUserId: OTHER.userId, ownerWorkspaceId: OTHER.workspaceId }));
    db.prepare('UPDATE activity_samples SET synced = 1').run();

    expect(store.unsyncedInRange(OWNER, 0, 3_000)).toBe(0);
    expect(store.markUnsyncedInRange(OWNER, 1_000, 5_000)).toBe(2);
    expect(store.unsyncedInRange(OWNER, 0, 10_000)).toBe(2);
    expect(store.unsyncedInRange(OTHER, 0, 10_000)).toBe(0);
    expect(store.unsynced(10, OWNER).map((r) => r.bucketStart)).toEqual([1_000, 2_000]);
  });
});
