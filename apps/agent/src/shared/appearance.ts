/** How the app's windows are painted, chosen in Settings → Appearance. */
export type AppTheme = 'system' | 'light' | 'dark';
/** The floating timer pill sits over other apps, so its theme is chosen on its own. */
export type PillTheme = 'light' | 'dark';

export interface Appearance {
  app: AppTheme;
  pill: PillTheme;
}

export const DEFAULT_APPEARANCE: Appearance = { app: 'system', pill: 'light' };

export function isAppTheme(v: unknown): v is AppTheme {
  return v === 'system' || v === 'light' || v === 'dark';
}

export function isPillTheme(v: unknown): v is PillTheme {
  return v === 'light' || v === 'dark';
}
