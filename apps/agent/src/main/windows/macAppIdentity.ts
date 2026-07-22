import { app, type BrowserWindow } from 'electron';

let fullscreenAttentionOwner: BrowserWindow | null = null;

/**
 * Restore Timo's normal Dock and Cmd+Tab identity after a temporary blocking
 * attention presentation.
 */
export function ensureRegularMacApplication(): void {
  if (process.platform !== 'darwin') return;
  app.setActivationPolicy('regular');
}

/**
 * Electron must temporarily make the host a UIElement application for a
 * normal BrowserWindow to join another app's fullscreen Space. This is a
 * process-wide transition, so the single attention window owns it as a lease.
 * Repeated raises, wake events and display changes must never repeat it.
 */
export function enterMacFullscreenAttention(window: BrowserWindow): void {
  if (process.platform !== 'darwin' || window.isDestroyed()) return;
  if (fullscreenAttentionOwner === window) return;

  if (fullscreenAttentionOwner) {
    fullscreenAttentionOwner = null;
    ensureRegularMacApplication();
  }
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  fullscreenAttentionOwner = window;
}

/** Restore normal Dock and Cmd+Tab identity after the blocking prompt leaves. */
export function leaveMacFullscreenAttention(window?: BrowserWindow): void {
  if (process.platform !== 'darwin') return;
  if (!fullscreenAttentionOwner) return;
  if (window && fullscreenAttentionOwner !== window) return;

  fullscreenAttentionOwner = null;
  ensureRegularMacApplication();
}
