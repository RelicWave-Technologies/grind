import { getCurrentWindow } from '@tauri-apps/api/window';
import regions from 'virtual:app-region';

/**
 * Window dragging for Tauri. Electron drags any element styled
 * `-webkit-app-region: drag`; WKWebView ignores that property, so the renderer's
 * own rules (extracted at build time by scripts/appRegionPlugin.ts) are replayed
 * here: the nearest ancestor that is `no-drag` wins, then the nearest `drag`.
 */
const DRAG = regions.drag.join(',');
const NO_DRAG = regions.noDrag.join(',');

function regionOf(target: Element): 'drag' | 'no-drag' | null {
  for (let el: Element | null = target; el; el = el.parentElement) {
    if (NO_DRAG && el.matches(NO_DRAG)) return 'no-drag';
    if (DRAG && el.matches(DRAG)) return 'drag';
  }
  return null;
}

/** Start dragging on a primary-button mousedown inside a drag region. */
export function installDragRegions(): void {
  window.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    if (regionOf(event.target) !== 'drag') return;
    getCurrentWindow()
      .startDragging()
      .catch(() => undefined);
  });
}
