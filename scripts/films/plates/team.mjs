// Team plate: the dashboard for a manager (the mock's Arjun). Team today, attendance for the
// month, a manual-time request approved, then the week in reports. Four chapters, one route
// each, with a crossfade between them.
// Run: node scripts/films/plates/team.mjs  → /tmp/timo-film/plates/team/{frames,cuts.json}
import { open, dashboard, HIDE } from '../lib/harness.mjs';
import { createPlate } from '../lib/plate.mjs';

const OUT = `${process.env.TIMO_FILM_WORK ?? '/tmp/timo-film'}/plates/team`;
const { browser, page, log } = await open({ width: 1600, height: 1000 });
await dashboard(page, 'MANAGER', '/overview');
await page.waitForTimeout(1500);
const s = await createPlate(page, { outDir: `${OUT}/frames`, hide: HIDE });
await page.evaluate(() => window.__settle());
const on = (r, scale, dx = 0, dy = 0) => ({ x: r.x + r.w / 2 + dx, y: r.y + r.h / 2 + dy, s: scale });
const wide = { x: 800, y: 500, s: 1 };

/** Go to another screen through the sidebar, the way a person would. */
async function visit(label, route) {
  const link = page.locator('nav a, aside a').filter({ hasText: label }).first();
  await s.tween(10, { cur: { o: 1 } });
  await s.moveTo(link, { frames: 22 });
  await s.click(link, { changes: 10, settleMs: 0 });
  await page.waitForURL(`**${route}*`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__settle());
}

// 1. The team, today.
s.mark('today');
await s.hold(20);
const kpis = page.locator('main [class*="kpi"], main [class*="stat"]').first();
if (await kpis.count()) {
  const k = await s.rect(kpis);
  await s.tween(30, { cam: on(k, 1.28, 90, 40), cur: { o: 0 } });
  await s.hold(50);
  await s.tween(24, { cam: wide });
} else await s.hold(100);

// 2. Who is in: the month's attendance.
await visit('Attendance', '/attendance');
s.mark('attendance');
await s.tween(12, { cur: { o: 0 } });
await s.hold(20);
const table = page.locator('main table').first();
const t = await s.rect(table);
await s.tween(30, { cam: on(t, 1.3, 0, -40) });
await s.hold(56);
await s.tween(24, { cam: wide });

// 3. Waiting on you: approve a manual-time request.
await visit('Approvals', '/approvals');
s.mark('approvals');
await s.hold(16);
const approve = page.getByRole('button', { name: /^Approve/ }).first();
const row = approve.locator('xpath=ancestor::tr[1]');
const r = await s.rect(row);
await s.tween(30, { cam: on(r, 1.22, 40, 30) });
await s.moveTo(approve, { frames: 22 });
await s.hold(8);
await s.click(approve, { changes: 8, settleMs: 300 });
s.mark('approved');
await s.tween(12, { cur: { o: 0 } });
await s.hold(40);
await s.tween(24, { cam: wide });

// 4. The week, honestly.
await visit('Reports', '/reports');
s.mark('reports');
await s.tween(12, { cur: { o: 0 } });
await s.hold(20);
const members = page.locator('main table').first();
const m = await s.rect(members);
await s.tween(32, { cam: on(m, 1.25, 0, -60) });
await s.hold(70);

const meta = s.finish();
console.log('frames', meta.frames, JSON.stringify(meta.marks));
console.log(log.join('\n'));
await browser.close();
