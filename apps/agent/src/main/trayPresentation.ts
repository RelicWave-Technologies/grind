const TRAY_APP_NAME = 'Timo';

export function trayMenuTitleForElapsed(
  elapsedText?: string | null,
  opts: { hasIcon?: boolean } = {},
): string {
  const hasIcon = opts.hasIcon ?? true;
  const elapsed = elapsedText?.trim();
  if (elapsed) return hasIcon ? ` ${elapsed}` : `${TRAY_APP_NAME} ${elapsed}`;
  return hasIcon ? '' : TRAY_APP_NAME;
}

export function trayTooltipForElapsed(elapsedText?: string | null): string {
  const elapsed = elapsedText?.trim();
  return elapsed ? `${TRAY_APP_NAME} ${elapsed}` : TRAY_APP_NAME;
}
