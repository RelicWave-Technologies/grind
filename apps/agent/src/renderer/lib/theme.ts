import type { Appearance } from '../../shared/appearance';

/**
 * Paints this window in its theme by setting `<html data-theme>`, which the
 * generated dark tokens key off. The floating pill follows the pill theme;
 * every other window follows the app theme, where "system" means the OS
 * appearance (prefers-color-scheme, which Electron drives from nativeTheme).
 * Runs before React mounts so the first paint is already in the right theme,
 * then follows Settings and the OS live.
 */
export function startTheme(route: string): void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let appearance: Appearance | null = null;

  const paint = () => {
    if (!appearance) return;
    const dark = route === 'floating'
      ? appearance.pill === 'dark'
      : appearance.app === 'dark' || (appearance.app === 'system' && media.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  };

  media.addEventListener('change', paint);
  // A preload older than this renderer (a dev reload before the main process
  // restarts) has no appearance bridge: stay light rather than fail to mount.
  if (typeof window.agent.settings.getAppearance !== 'function') return;
  window.agent.settings.onAppearanceChange((next) => {
    appearance = next;
    paint();
  });
  void window.agent.settings.getAppearance().then((initial) => {
    appearance ??= initial;
    paint();
  });
}
