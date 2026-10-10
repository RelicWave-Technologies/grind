/**
 * Screenshot queue health the heartbeat reports, kept apart from the capture
 * loop so the heartbeat does not have to load it (and sharp) to read two
 * values. Both used to live only in the log, where nobody saw a machine that
 * had stopped keeping or sending its screenshots.
 */
let overdueUnuploaded = 0;
let diskFull = false;

/** Shots past retention that are kept only because they have not uploaded yet. */
export function noteOverdueScreenshots(count: number): void {
  overdueUnuploaded = count;
}

/** Whether the last capture could not be stored because the disk (or the database) is full. */
export function isScreenshotDiskFull(): boolean {
  return diskFull;
}

export function noteScreenshotDiskFull(full: boolean): void {
  diskFull = full;
}

export function getScreenshotDiagnostics(): { screenshotsOverdue: number; screenshotDiskFull: boolean } {
  return { screenshotsOverdue: overdueUnuploaded, screenshotDiskFull: diskFull };
}
