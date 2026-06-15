// Resolution order:
//   1. MAIN_VITE_API_URL — baked in at build time by electron-vite (this is how
//      the packaged/production DMG learns the Render API host, since a shipped
//      app has no process.env). Set it in apps/agent/.env.production.
//   2. AGENT_API_URL — runtime override for local dev / per-machine testing.
//   3. localhost fallback for `electron-vite dev`.
export const API_URL: string =
  import.meta.env.MAIN_VITE_API_URL || process.env.AGENT_API_URL || 'http://localhost:4000';
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

/** Screenshot cadence in seconds. Server policy (per-user → workspace) drives
 *  this at runtime via /v1/agent/config; this is just the boot/offline default.
 *  Set AGENT_SHOT_SEC (e.g. 15) to LOCK it for testing (server won't override). */
export const SCREENSHOT_INTERVAL_SEC: number = Number(process.env.AGENT_SHOT_SEC ?? 10_800);
/** True when AGENT_SHOT_SEC is explicitly set → a hard local override that the
 *  server-config refresh must not clobber. */
export const SHOT_SEC_LOCKED: boolean = process.env.AGENT_SHOT_SEC != null;
/** Same lock semantics for the idle threshold (AGENT_IDLE_SEC). */
export const IDLE_SEC_LOCKED: boolean = process.env.AGENT_IDLE_SEC != null;
/** WebP quality (0–100) for stored screenshots. */
export const SCREENSHOT_QUALITY: number = Number(process.env.AGENT_SHOT_QUALITY ?? 82);
/** Max long-edge px; larger displays are downscaled to this. */
export const SCREENSHOT_MAX_EDGE: number = 2560;
/** Days to keep local screenshots before the on-boot janitor prunes them.
 *  Mirrors the 60-day workspace retention default. <= 0 disables time-based
 *  expiry (orphan/dangling reconciliation still runs). */
export const SCREENSHOT_RETENTION_DAYS: number = Number(process.env.AGENT_SHOT_RETENTION_DAYS ?? 60);
