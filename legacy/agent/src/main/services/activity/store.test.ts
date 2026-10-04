import { describe, expect, it, vi } from 'vitest';
import { ActivityStore } from './store';

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
