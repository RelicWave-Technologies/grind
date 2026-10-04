import { createRoot } from 'react-dom/client';
import { DevPanel, PANEL_CSS } from './DevPanel';

// The public site (landing, changelog, privacy) is what ships; the dev panel
// never shows on it, not even for the moment before the page has drawn.
const PUBLIC = ['/', '/welcome', '/changelog', '/privacy'];
const onPublicPage = () => PUBLIC.includes(window.location.pathname.replace(/\/+$/, '') || '/');

/** Hides the host on public pages, and follows the app's own navigation. */
function followRoute(host: HTMLElement): void {
  const sync = () => {
    host.style.setProperty('display', onPublicPage() ? 'none' : 'block');
  };
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method].bind(history);
    history[method] = (...args: Parameters<History['pushState']>) => {
      original(...args);
      sync();
    };
  }
  window.addEventListener('popstate', sync);
  sync();
}

/** Mounts the dev panel in a shadow root pinned to the bottom-left corner. */
export function mountPanel(): void {
  const host = document.createElement('div');
  host.id = 'timo-mock-panel';
  host.setAttribute(
    'style',
    'all: initial; position: fixed; left: 12px; bottom: 12px; z-index: 2147483647; display: block;',
  );
  followRoute(host);
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = PANEL_CSS;
  shadow.appendChild(style);
  const container = document.createElement('div');
  shadow.appendChild(container);
  createRoot(container).render(<DevPanel />);
}
