/**
 * Build identity surfaced on /healthz so curl-checks can confirm a
 * given pod is running the expected commit. `GIT_SHA` is set from the deployed
 * image tag (infra/vps/docker-compose.prod.yml). Falls back to "dev" when unset
 * (local + tests).
 *
 * START_TIME_MS is captured at module load so /healthz reports a stable
 * uptime per process. Test environments build a fresh app per `seed()`
 * so the test uptime will be small but the field is still useful.
 */

export const API_VERSION = process.env.GIT_SHA?.trim() || 'dev';

export const START_TIME_MS = Date.now();
