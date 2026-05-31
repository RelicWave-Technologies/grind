export const API_URL: string = process.env.AGENT_API_URL ?? 'http://localhost:4000';
export const AGENT_VERSION: string = process.env.npm_package_version ?? '0.0.1';
export const HEARTBEAT_INTERVAL_MS: number = 60_000;

/** Seconds of no input before the "are you still working?" prompt. Default 5 min.
 *  Override with AGENT_IDLE_SEC (e.g. 20) for testing. */
export const IDLE_THRESHOLD_SEC: number = Number(process.env.AGENT_IDLE_SEC ?? 300);
/** How often to poll the OS idle timer. Capped so the poll period is never
 *  larger than half the idle threshold (otherwise a 20s threshold with a
 *  5s poll could miss by up to 5s; with low test thresholds we want
 *  ~1-2s resolution). */
export const IDLE_POLL_MS: number = Math.max(500, Math.min(5_000, Math.floor(IDLE_THRESHOLD_SEC * 1000 / 4)));

/** Screenshot cadence in seconds. Default 3 hours (jittered to ~1.5–3h).
 *  Override with AGENT_SHOT_SEC (e.g. 15) for testing. */
export const SCREENSHOT_INTERVAL_SEC: number = Number(process.env.AGENT_SHOT_SEC ?? 10_800);
/** WebP quality (0–100) for stored screenshots. */
export const SCREENSHOT_QUALITY: number = Number(process.env.AGENT_SHOT_QUALITY ?? 82);
/** Max long-edge px; larger displays are downscaled to this. */
export const SCREENSHOT_MAX_EDGE: number = 2560;
