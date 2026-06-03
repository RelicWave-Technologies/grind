/**
 * Pure per-day app/site usage roll-up (M14). Eats per-minute ActivitySample
 * rows already-filtered to the day window and emits top-N applications by
 * minute count, plus aggregate keystrokes + clicks per app for richer
 * display. The server has already scrubbed disallowed fields per the
 * workspace policy by the time samples reach here — so this stage just
 * counts what survived ingestion.
 *
 * Bucketing is by (app, bundle) tuple: a "Chrome" build with a different
 * bundle would land in its own group. activeTitle / activeUrl are not
 * aggregated here — they vary by minute and the insight is intentionally
 * one-line-per-app. Specific URL/title timelines can land on a separate
 * /v1/insights/day/apps route if needed later.
 */

export interface AppUsageSample {
  activeApp: string | null;
  activeAppBundle: string | null;
  keystrokes: number;
  clicks: number;
}

export interface AppUsageEntry {
  app: string;
  appBundle: string | null;
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

  // Key by (app|bundle) tuple so two apps that happen to share a display
  // name don't fold together.
  type Agg = { app: string; appBundle: string | null; minutes: number; keystrokes: number; clicks: number };
  const map = new Map<string, Agg>();
  let totalMinutes = 0;

  for (const s of samples) {
    if (!s.activeApp) continue;
    totalMinutes += 1;
    const key = `${s.activeApp}\x00${s.activeAppBundle ?? ''}`;
    const existing = map.get(key);
    if (existing) {
      existing.minutes += 1;
      existing.keystrokes += s.keystrokes;
      existing.clicks += s.clicks;
    } else {
      map.set(key, {
        app: s.activeApp,
        appBundle: s.activeAppBundle,
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
