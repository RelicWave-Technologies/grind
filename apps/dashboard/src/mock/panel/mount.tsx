import { createRoot } from 'react-dom/client';
import { DevPanel, PANEL_CSS } from './DevPanel';

/** Mounts the dev panel in a shadow root pinned to the bottom-left corner. */
export function mountPanel(): void {
  const host = document.createElement('div');
  host.id = 'timo-mock-panel';
  host.setAttribute(
    'style',
    'all: initial; position: fixed; left: 12px; bottom: 12px; z-index: 2147483647; display: block;',
  );
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = PANEL_CSS;
  shadow.appendChild(style);
  const container = document.createElement('div');
  shadow.appendChild(container);
  createRoot(container).render(<DevPanel />);
}
