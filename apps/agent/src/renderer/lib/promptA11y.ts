import { useEffect, useRef } from 'react';

/**
 * Keyboard answers for the small prompt windows: Enter takes the primary
 * action, Escape the secondary (or dismissing) one.
 *
 * Enter on a focused button is left to the button, so Tab-then-Enter still
 * answers with whatever the person moved to.
 */
export function usePromptKeys(keys: {
  primary: () => void;
  secondary?: () => void;
  disabled?: boolean;
}): void {
  const latest = useRef(keys);
  latest.current = keys;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { primary, secondary, disabled } = latest.current;
      if (disabled || event.repeat) return;
      if (event.key === 'Escape' && secondary) {
        event.preventDefault();
        secondary();
      } else if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
        event.preventDefault();
        primary();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

/** How often a running countdown is read out. */
export const COUNTDOWN_ANNOUNCE_EVERY_SEC = 10;

/**
 * What a screen reader should hear for a countdown at `remaining` seconds, or
 * null to stay quiet. Once at the start and then every ten seconds — reading
 * every tick drowns out everything else.
 */
export function countdownAnnouncement(remaining: number, isStart: boolean): string | null {
  if (remaining <= 0) return null;
  if (!isStart && remaining % COUNTDOWN_ANNOUNCE_EVERY_SEC !== 0) return null;
  return `${remaining} second${remaining === 1 ? '' : 's'} left`;
}
