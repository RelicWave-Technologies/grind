/**
 * Pure retention + reconciliation planner for the LOCAL screenshot cache
 * (no Electron / no fs), so it's fully unit-testable.
 *
 * Since screenshots are local-only today (no S3 upload yet), the cache must be
 * self-bounding and self-healing, like Hubstaff/Time Doctor's local caches:
 *
 *  - **Retention**: files + rows older than `retentionDays` are pruned so disk
 *    can't grow without bound (brutal at the fast dogfood cadence).
 *  - **Orphan files**: a `.webp` on disk with no DB row (e.g. a crash between
 *    `writeFile` and the row `insert`) is deleted — it would never be shown.
 *  - **Dangling rows**: a row whose file has vanished is dropped, so the gallery
 *    never renders a broken thumbnail.
 *
 * The planner takes the current DB rows + the files actually on disk and returns
 * exactly what to delete; the thin shell executes it.
 */
export interface RetentionRow {
  id: string;
  filePath: string;
  capturedAt: number;
}

export interface RetentionInput {
  rows: RetentionRow[];
  /** Absolute paths of `.webp` files found under the screenshots dir. */
  filesOnDisk: string[];
  now: number;
  /** Days to keep. <= 0 disables time-based expiry (reconcile-only). */
  retentionDays: number;
}

export interface RetentionPlan {
  filesToDelete: string[];
  rowIdsToDelete: string[];
  /** Counters for logging/observability. */
  expired: number;
  orphanFiles: number;
  danglingRows: number;
}

const DAY_MS = 86_400_000;

export function planScreenshotRetention(input: RetentionInput): RetentionPlan {
  const { rows, filesOnDisk, now, retentionDays } = input;
  const expire = retentionDays > 0;
  const cutoff = now - retentionDays * DAY_MS;

  const diskSet = new Set(filesOnDisk);
  const rowPaths = new Set(rows.map((r) => r.filePath));

  const filesToDelete = new Set<string>();
  const rowIdsToDelete = new Set<string>();
  let expired = 0;
  let danglingRows = 0;

  for (const r of rows) {
    if (expire && r.capturedAt < cutoff) {
      expired++;
      rowIdsToDelete.add(r.id);
      if (diskSet.has(r.filePath)) filesToDelete.add(r.filePath);
    } else if (!diskSet.has(r.filePath)) {
      // File gone but row not yet expired → drop the dangling row.
      danglingRows++;
      rowIdsToDelete.add(r.id);
    }
  }

  let orphanFiles = 0;
  for (const f of filesOnDisk) {
    if (!rowPaths.has(f)) {
      orphanFiles++;
      filesToDelete.add(f);
    }
  }

  return {
    filesToDelete: [...filesToDelete],
    rowIdsToDelete: [...rowIdsToDelete],
    expired,
    orphanFiles,
    danglingRows,
  };
}
