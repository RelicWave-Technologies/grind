export const API_URL: string = process.env.AGENT_API_URL ?? 'http://localhost:4000';
export const AGENT_VERSION: string = process.env.npm_package_version ?? '0.0.1';
export const HEARTBEAT_INTERVAL_MS: number = 60_000;

/** Seconds of no input before the "are you still working?" prompt. Default 5 min.
 *  Override with AGENT_IDLE_SEC (e.g. 20) for testing. */
export const IDLE_THRESHOLD_SEC: number = Number(process.env.AGENT_IDLE_SEC ?? 300);
/** How often to poll the OS idle timer. */
export const IDLE_POLL_MS: number = 5_000;
