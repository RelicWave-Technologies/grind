// Day plate: Edit time for a member (the mock's Ananya). The day on one ribbon, then down to
// the timesheet: a gap where nobody pressed play, a reason typed into it, sent for approval,
// and the row turning Pending.
// Run: node scripts/films/plates/day.mjs  → /tmp/timo-film/plates/day/{frames,cuts.json}
import { open, dashboard, HIDE } from '../lib/harness.mjs';
import { createPlate } from '../lib/plate.mjs';

const OUT = `${process.env.TIMO_FILM_WORK ?? '/tmp/timo-film'}/plates/day`;
const { browser, page, log } = await open({ width: 1600, height: 1000 });
await dashboard(page, 'MEMBER', '/edit-time');
await page.waitForTimeout(1500);
const s = await createPlate(page, { outDir: `${OUT}/frames`, hide: HIDE });
await page.evaluate(() => window.__settle());
const on = (r, scale, dx = 0, dy = 0) => ({ x: r.x + r.w / 2 + dx, y: r.y + r.h / 2 + dy, s: scale });

// 1. The day on one ribbon.
s.mark('day');
await s.hold(16);
const ribbon = page.locator('.ribbon, [class*="ribbon"]').first();
const r = await s.rect(ribbon);
await s.tween(34, { cam: on(r, 1.45, 0, 10), cur: { o: 0 } });
await s.hold(56);
await s.tween(26, { cam: { x: 800, y: 500, s: 1 } });

// 2. Down to the timesheet, to a gap nobody tracked.
// The mock's day follows the real clock, so its gaps move; take the first one after the
// overnight gap (the row that starts at midnight).
const gap = page.locator('.et-row-gap').filter({ hasNotText: '12:00 AM' }).first();
await s.scrollInto(gap, { top: 330, frames: 36 });
s.mark('gap');
const g = await s.rect(gap);
await s.tween(30, { cam: on(g, 1.24, 0, 40) });
await s.hold(20);

// 3. Say what it was, and send it.
const why = gap.locator('textarea, input').first();
await s.tween(10, { cur: { o: 1 } });
await s.moveTo(why, { frames: 22 });
await s.click(why);
s.mark('type');
await s.type('Stand-up with the design team', { perFrame: 1 });
await s.hold(14);
const send = gap.getByRole('button', { name: /Send for approval/ });
await s.moveTo(send, { frames: 20 });
await s.click(send, { changes: 8, settleMs: 400 });
s.mark('sent');
await s.tween(12, { cur: { o: 0 } });
await s.hold(70);

const meta = s.finish();
console.log('frames', meta.frames, JSON.stringify(meta.marks));
console.log(log.join('\n'));
await browser.close();
