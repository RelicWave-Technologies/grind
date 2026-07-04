/**
 * Pure per-day app/site usage roll-up (M14). Eats per-minute ActivitySample
 * rows already-filtered to the day window and emits top-N applications by
 * minute count, plus aggregate keystrokes + clicks per app for richer
 * display. The server has already scrubbed disallowed fields per the
 * workspace policy by the time samples reach here — so this stage just
 * counts what survived ingestion.
 *
 * Bucketing is by site domain when a policy-allowed activeUrl is present,
 * otherwise by (app, bundle) tuple. This lets browser work show "github.com"
 * with a favicon while desktop apps keep their real OS app icon.
 */

export interface AppUsageSample {
  activeApp: string | null;
  activeAppBundle: string | null;
  activeUrl?: string | null;
  keystrokes: number;
  clicks: number;
}

export interface AppUsageEntry {
  app: string;
  appBundle: string | null;
  domain?: string;
  sourceApp?: string | null;
  sourceAppBundle?: string | null;
  minutes: number;
  keystrokes: number;
  clicks: number;
}

export interface AppUsageInsight {
  totalMinutes: number; // total minutes with ANY active app
  topApps: AppUsageEntry[];
}

const DEFAULT_TOP_N = 10;

/**
 * Build the top-N app usage roll-up for a day window. Samples with a null
 * activeApp are counted in `totalMinutes` for ratio math? — NO: we only
 * count minutes that actually had an attributable app. That matches the
 * dashboard's "what apps were used" framing.
 */
export function buildAppUsage(samples: AppUsageSample[], topN = DEFAULT_TOP_N): AppUsageInsight {
  if (samples.length === 0) return { totalMinutes: 0, topApps: [] };

  // Key by site domain when available, else by (app|bundle) tuple so two apps
  // that happen to share a display name don't fold together.
  type Agg = AppUsageEntry;
  const map = new Map<string, Agg>();
  let totalMinutes = 0;

  for (const s of samples) {
    if (!s.activeApp) continue;
    const identity = appUsageIdentity(s);
    if (!identity) continue;
    totalMinutes += 1;
    const existing = map.get(identity.key);
    if (existing) {
      existing.minutes += 1;
      existing.keystrokes += s.keystrokes;
      existing.clicks += s.clicks;
    } else {
      map.set(identity.key, {
        app: identity.app,
        appBundle: identity.appBundle,
        ...(identity.domain ? { domain: identity.domain } : {}),
        ...(identity.sourceApp !== undefined ? { sourceApp: identity.sourceApp } : {}),
        ...(identity.sourceAppBundle !== undefined ? { sourceAppBundle: identity.sourceAppBundle } : {}),
        minutes: 1,
        keystrokes: s.keystrokes,
        clicks: s.clicks,
      });
    }
  }

  const all = Array.from(map.values()).sort((a, b) => {
    if (b.minutes !== a.minutes) return b.minutes - a.minutes;
    // Tie-break: more keystrokes wins; then alphabetical for stability.
    if (b.keystrokes !== a.keystrokes) return b.keystrokes - a.keystrokes;
    return a.app.localeCompare(b.app);
  });

  return {
    totalMinutes,
    topApps: all.slice(0, topN),
  };
}

export interface AppUsageIdentity {
  key: string;
  app: string;
  appBundle: string | null;
  domain?: string;
  sourceApp?: string | null;
  sourceAppBundle?: string | null;
}

export function appUsageIdentity(sample: Pick<AppUsageSample, 'activeApp' | 'activeAppBundle' | 'activeUrl'>): AppUsageIdentity | null {
  if (!sample.activeApp) return null;
  const domain = domainFromActiveUrl(sample.activeUrl ?? null);
  if (domain) {
    return {
      key: `site:${domain}`,
      app: domain,
      appBundle: null,
      domain,
      sourceApp: sample.activeApp,
      sourceAppBundle: sample.activeAppBundle,
    };
  }
  return {
    key: `app:${sample.activeApp}\x00${sample.activeAppBundle ?? ''}`,
    app: sample.activeApp,
    appBundle: sample.activeAppBundle,
  };
}

export function domainFromActiveUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!host) return null;
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return null;
  }
}
