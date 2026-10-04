import { isTauri } from '@tauri-apps/api/core';
import { createAgentBridge } from './agentBridge';
import { installDragRegions } from '../dragRegions';

/**
 * Wire the renderer to the Tauri shell. A no-op outside Tauri, and when a
 * `window.agent` already exists: the Agent Lab (`pnpm lab`) puts a fake one in
 * place before this module runs, and must keep it.
 */
export function installTauriShell(): void {
  if (!isTauri() || window.agent) return;
  window.agent = createAgentBridge();
  installDragRegions();
}
