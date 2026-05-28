export const API_URL: string = process.env.AGENT_API_URL ?? 'http://localhost:4000';
export const AGENT_VERSION: string = process.env.npm_package_version ?? '0.0.1';
export const HEARTBEAT_INTERVAL_MS: number = 60_000;
