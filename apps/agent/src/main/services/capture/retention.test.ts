import { describe, it, expect } from 'vitest';
import { planScreenshotRetention, type RetentionInput } from './retention';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function row(id: string, filePath: string, ageDays: number) {
  return { id, filePath, capturedAt: NOW - ageDays * DAY };
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
