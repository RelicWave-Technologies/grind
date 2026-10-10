/**
 * Pure retention + reconciliation planner for the LOCAL screenshot cache
 * (no Electron / no fs), so it's fully unit-testable.
 *
 * The local cache holds every shot until it is uploaded (and a small copy for
 * the gallery after), so it must be self-bounding and self-healing, like
 * Hubstaff/Time Doctor's local caches:
 *
 *  - **Retention**: files + rows older than `retentionDays` are pruned so disk
 *    can't grow without bound (brutal at the fast dogfood cadence).
 *  - **Orphan files**: a `.webp` on disk with no DB row (e.g. a crash between
 *    `writeFile` and the row `insert`) is deleted — it would never be shown.
 *  - **Dangling rows**: a row whose file has vanished is dropped, so the gallery
 *    never renders a broken thumbnail.
 *  - **Never the only copy**: a shot the server does not have yet is never
 *    deleted, row or file, however old. Past the window it is only counted
 *    (`overdueUnuploaded`) so the backlog is visible instead of silently lost.
 *    A pending shot whose file vanished keeps its row too: the uploader reads
 *    the missing file, writes it off and tells the server, and the next run
 *    drops the failed row.
 *
 * The planner takes the current DB rows + the files actually on disk and returns
 * exactly what to delete; the thin shell executes it.
 */
interface RetentionRow {
  id: string;
  filePath: string;
  capturedAt: number;
  uploadState: 'pending' | 'uploading' | 'uploaded' | 'failed';
}

/** A `.webp` found under the screenshots dir. */
export interface DiskFile {
  path: string;
  mtimeMs: number;
}

export interface RetentionInput {
  /** Rows read BEFORE the disk was listed, with absolute file paths. */
  rows: RetentionRow[];
  /** Absolute paths of `.webp` files found under the screenshots dir. */
  filesOnDisk: string[];
  /**
   * Files too new to judge: a capture may have written the file and not yet
   * inserted its row. Never deleted as orphans.
   */
  protectedFiles?: string[];
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
  /** Past the window but kept: the server does not have them yet. */
  overdueUnuploaded: number;
}

const DAY_MS = 86_400_000;

/**
 * Days to keep local copies: the workspace's screenshot retention when known
 * (bounded to the privacy contract's 1–60 by the caller), never longer than the
 * agent's own cap. A cap <= 0 (dev) disables expiry, as before.
 */
export function localRetentionDays(policyDays: number | null, capDays: number): number {
  if (capDays <= 0) return capDays;
  if (policyDays === null || !Number.isFinite(policyDays) || policyDays < 1) return capDays;
  return Math.min(Math.floor(policyDays), capDays);
}

export function planScreenshotRetention(input: RetentionInput): RetentionPlan {
  const { rows, filesOnDisk, now, retentionDays } = input;
  const expire = retentionDays > 0;
  const cutoff = now - retentionDays * DAY_MS;

  const diskSet = new Set(filesOnDisk);
  const rowPaths = new Set(rows.map((r) => r.filePath));
  const protectedSet = new Set(input.protectedFiles ?? []);

  const filesToDelete = new Set<string>();
  const rowIdsToDelete = new Set<string>();
  let expired = 0;
  let danglingRows = 0;
  let overdueUnuploaded = 0;

  for (const r of rows) {
    const onDisk = diskSet.has(r.filePath);
    const uploaded = r.uploadState === 'uploaded';
    if (expire && r.capturedAt < cutoff) {
      if (uploaded || (r.uploadState === 'failed' && !onDisk)) {
        expired++;
        rowIdsToDelete.add(r.id);
        if (onDisk) filesToDelete.add(r.filePath);
      } else {
        overdueUnuploaded++;
      }
    } else if (!onDisk && (uploaded || r.uploadState === 'failed')) {
      // File gone and nothing left to upload → drop the dangling row.
      danglingRows++;
      rowIdsToDelete.add(r.id);
    }
  }

  let orphanFiles = 0;
  for (const f of filesOnDisk) {
    if (!rowPaths.has(f) && !protectedSet.has(f)) {
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
    overdueUnuploaded,
  };
}
