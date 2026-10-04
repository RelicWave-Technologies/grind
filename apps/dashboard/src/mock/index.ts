/**
 * Mock mode entry — loaded only when VITE_MOCK === '1' (see main.tsx), so a
 * normal build never contains any of this.
 *
 *   pnpm --filter @grind/dashboard dev:mock   → http://localhost:5174
 *
 * Answers every /v1 request in the browser from generated, date-relative
 * data for a fictional 16-person agency, and mounts a small dev panel
 * (bottom-left) to switch role, session, latency, empty and error states.
 */
import { todayKey } from './clock';
import { getDb, resetDb } from './db';
import { issues } from './dispatch';
import { installFetch } from './fetch';
import { mountPanel } from './panel/mount';
import { selfTest } from './selftest';
import { getSettings, updateSettings } from './settings';

// The Lark sign-in round trip in mock mode ends at /home?mock_signin=1
// (see the mock plugin in vite.config.ts). Consume it before the router runs.
const url = new URL(window.location.href);
if (url.searchParams.get('mock_signin') === '1') {
  updateSettings({ signedOut: false });
  url.searchParams.delete('mock_signin');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

installFetch();
getDb(todayKey());
mountPanel();

declare global {
  interface Window {
    __timoMock?: {
      settings: typeof getSettings;
      update: typeof updateSettings;
      selfTest: typeof selfTest;
      /** Unmocked routes, handler crashes and schema drift seen by this page. */
      issues: () => typeof issues;
      reset: () => void;
    };
  }
}

window.__timoMock = {
  settings: getSettings,
  update: updateSettings,
  selfTest,
  issues: () => issues,
  reset: () => {
    resetDb();
    window.location.reload();
  },
};

console.info(
  `%c[timo mock]%c API answered in the browser · ${getSettings().signedOut ? 'signed out' : `signed in as ${getSettings().role}`} · __timoMock.selfTest() checks every route`,
  'color:#F59E0B;font-weight:bold',
  'color:inherit',
);
