import { broadcast } from '../../broadcast';

/** Notify renderers that screenshot metadata, media, or upload state changed. */
export function broadcastScreenshotChange(): void {
  broadcast('screenshots:changed', null);
}
