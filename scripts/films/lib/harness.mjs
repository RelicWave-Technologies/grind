// harness.mjs — opens the app a plate films: the mock dashboard (`pnpm dev:mock`, every /v1
// call answered in the browser) or a desktop window in the Agent Lab (`pnpm lab`). Both run
// on dummy data with made-up people, so nothing real is ever filmed.
import { chromium } from './playwright.mjs';

export const DASHBOARD = process.env.TIMO_DASHBOARD ?? 'http://localhost:5177';
export const LAB = process.env.TIMO_LAB ?? 'http://localhost:5176';

/** The dev panel lives in a shadow root on this host; a film never shows it. */
export const HIDE = ['#timo-mock-panel'];

export async function open({ width = 1440, height = 900, scale = 1.25, clock = false } = {}) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  const log = [];
  page.on('pageerror', (e) => log.push('pageerror: ' + e.message));
  if (clock) await page.clock.install();
  return { browser, page, log };
}

/** The mock dashboard as one role, the panel folded away. */
export async function dashboard(page, role, route) {
  await page.addInitScript((r) => {
    localStorage.setItem('timo.mock.settings', JSON.stringify({ role: r, collapsed: true }));
    sessionStorage.setItem('timo-intro', 'seen');
  }, role);
  await page.goto(`${DASHBOARD}${route}`, { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: '#timo-mock-panel{display:none!important}' });
}

/** One desktop window from the Agent Lab, at its real size. */
export async function lab(page, query, hash = '') {
  await page.goto(`${LAB}/lab/surface.html?${query}&frame=film#${hash}`, { waitUntil: 'networkidle' });
}
