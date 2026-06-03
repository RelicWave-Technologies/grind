/**
 * Build identity surfaced on /healthz so curl-checks can confirm a
 * given pod is running the expected commit. `process.env.GIT_SHA` is
 * stamped by CI; falls back to "dev" when unset (local + tests).
 *
 * START_TIME_MS is captured at module load so /healthz reports a stable
 * uptime per process. Test environments build a fresh app per `seed()`
 * so the test uptime will be small but the field is still useful.
 */

export const API_VERSION =
  (process.env.GIT_SHA && process.env.GIT_SHA.length > 0 && process.env.GIT_SHA) || 'dev';

export const START_TIME_MS = Date.now();
