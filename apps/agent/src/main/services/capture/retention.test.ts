import { describe, it, expect } from 'vitest';
import { localRetentionDays, planScreenshotRetention, type RetentionInput } from './retention';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

type State = 'pending' | 'uploading' | 'uploaded' | 'failed';
function row(id: string, filePath: string, ageDays: number, uploadState: State = 'uploaded') {
  return { id, filePath, capturedAt: NOW - ageDays * DAY, uploadState };
}

function plan(partial: Partial<RetentionInput> & Pick<RetentionInput, 'rows' | 'filesOnDisk'>) {
  return planScreenshotRetention({ now: NOW, retentionDays: 60, ...partial });
}

describe('planScreenshotRetention', () => {
  it('keeps fresh rows whose files exist, deletes nothing', () => {
    const p = plan({
      rows: [row('a', '/s/a.webp', 1), row('b', '/s/b.webp', 10)],
      filesOnDisk: ['/s/a.webp', '/s/b.webp'],
    });
    expect(p.filesToDelete).toEqual([]);
    expect(p.rowIdsToDelete).toEqual([]);
  });

  it('expires rows + their files past the retention window', () => {
    const p = plan({
      rows: [row('old', '/s/old.webp', 61), row('new', '/s/new.webp', 1)],
      filesOnDisk: ['/s/old.webp', '/s/new.webp'],
    });
    expect(p.rowIdsToDelete).toEqual(['old']);
    expect(p.filesToDelete).toEqual(['/s/old.webp']);
    expect(p.expired).toBe(1);
  });

  it('deletes orphan files on disk that have no row (crash between write and insert)', () => {
    const p = plan({
      rows: [row('a', '/s/a.webp', 1)],
      filesOnDisk: ['/s/a.webp', '/s/orphan.webp'],
    });
    expect(p.filesToDelete).toEqual(['/s/orphan.webp']);
    expect(p.rowIdsToDelete).toEqual([]);
    expect(p.orphanFiles).toBe(1);
  });

  it('drops dangling rows whose file has vanished (no broken thumbnails)', () => {
    const p = plan({
      rows: [row('a', '/s/a.webp', 1), row('gone', '/s/gone.webp', 2)],
      filesOnDisk: ['/s/a.webp'],
    });
    expect(p.rowIdsToDelete).toEqual(['gone']);
    expect(p.filesToDelete).toEqual([]); // file already gone — nothing to unlink
    expect(p.danglingRows).toBe(1);
  });

  it('does not list an already-expired file as an orphan (no double-count)', () => {
    const p = plan({
      rows: [row('old', '/s/old.webp', 90)],
      filesOnDisk: ['/s/old.webp'],
    });
    expect(p.filesToDelete).toEqual(['/s/old.webp']);
    expect(p.orphanFiles).toBe(0); // it has a row, so it's expiry not orphan
    expect(p.expired).toBe(1);
  });

  it('retentionDays <= 0 disables expiry but still reconciles orphans/dangling', () => {
    const p = plan({
      retentionDays: 0,
      rows: [row('ancient', '/s/ancient.webp', 999), row('gone', '/s/gone.webp', 1)],
      filesOnDisk: ['/s/ancient.webp', '/s/orphan.webp'],
    });
    expect(p.expired).toBe(0); // ancient kept — expiry disabled
    expect(p.rowIdsToDelete).toEqual(['gone']); // dangling row still dropped
    expect(p.filesToDelete).toEqual(['/s/orphan.webp']); // orphan still cleaned
  });

  it('handles the empty case', () => {
    const p = plan({ rows: [], filesOnDisk: [] });
    expect(p).toMatchObject({ filesToDelete: [], rowIdsToDelete: [], expired: 0, orphanFiles: 0, danglingRows: 0 });
  });
});

describe('planScreenshotRetention racing a capture', () => {
  it('never deletes a file too new to have its row yet', () => {
    const p = plan({
      rows: [row('a', '/s/a.webp', 1)],
      filesOnDisk: ['/s/a.webp', '/s/just-written.webp'],
      protectedFiles: ['/s/just-written.webp'],
    });
    expect(p.filesToDelete).toEqual([]);
    expect(p.orphanFiles).toBe(0);
  });
});

describe('planScreenshotRetention never deletes the only copy', () => {
  it('keeps a shot the server does not have yet, however old, and counts it', () => {
    const p = plan({
      rows: [
        row('pending', '/s/pending.webp', 90, 'pending'),
        row('uploading', '/s/uploading.webp', 90, 'uploading'),
        row('refused', '/s/refused.webp', 90, 'failed'),
        row('done', '/s/done.webp', 90, 'uploaded'),
      ],
      filesOnDisk: ['/s/pending.webp', '/s/uploading.webp', '/s/refused.webp', '/s/done.webp'],
    });
    expect(p.rowIdsToDelete).toEqual(['done']);
    expect(p.filesToDelete).toEqual(['/s/done.webp']);
    expect(p.overdueUnuploaded).toBe(3);
    expect(p.expired).toBe(1);
  });

  it('keeps a pending row whose file vanished so the uploader can report it; drops a failed one', () => {
    const p = plan({
      rows: [row('pending-gone', '/s/p.webp', 1, 'pending'), row('failed-gone', '/s/f.webp', 1, 'failed'), row('old-failed-gone', '/s/o.webp', 90, 'failed')],
      filesOnDisk: [],
    });
    expect(p.rowIdsToDelete.sort()).toEqual(['failed-gone', 'old-failed-gone']);
    expect(p.overdueUnuploaded).toBe(0);
  });
});

describe('localRetentionDays', () => {
  it('follows a shorter workspace policy but never exceeds the agent cap', () => {
    expect(localRetentionDays(7, 60)).toBe(7);
    expect(localRetentionDays(90, 60)).toBe(60);
    expect(localRetentionDays(null, 60)).toBe(60);
    expect(localRetentionDays(0, 60)).toBe(60); // "forever" / unknown reads as the cap
    expect(localRetentionDays(7, 0)).toBe(0); // dev: expiry disabled stays disabled
  });
});
