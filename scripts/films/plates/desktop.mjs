// Desktop plate: the Timo window (Focus) at its real 960×640. Nothing tracking; pick a task and
// the clock starts, ticking at its real speed; then My day, the counts behind the time.
// Run: node scripts/films/plates/desktop.mjs  → /tmp/timo-film/plates/desktop/{frames,cuts.json}
import { open, lab } from '../lib/harness.mjs';
import { createPlate } from '../lib/plate.mjs';

const OUT = `${process.env.TIMO_FILM_WORK ?? '/tmp/timo-film'}/plates/desktop`;
const { browser, page, log } = await open({ width: 960, height: 640, scale: 2, clock: true });
await lab(page, 'timer=idle&tab=today');
await page.waitForTimeout(5000); // the app's own opening animation
const s = await createPlate(page, { outDir: `${OUT}/frames`, clock: true });
await page.evaluate(() => window.__settle());

// 1. Nothing tracking: what are you working on?
s.mark('pick');
await s.hold(24);
const tile = page.locator('.focus-tile').filter({ hasText: 'Q3 client onboarding' }).first();
await s.moveTo(tile, { frames: 28, at: { x: 60, y: 34 } });
await s.hold(6);
await s.click(tile, { changes: 8, settleMs: 0 });

// 2. Tracking: the clock runs, in real seconds.
s.mark('tracking');
await s.hold(20);
await s.tween(14, { cur: { o: 0 } });
await s.hold(64);

// 3. My day: the counts behind the time.
const myDay = page.getByRole('button', { name: /My day/ }).first();
await s.tween(16, { cur: { o: 1 } });
await s.moveTo(myDay, { frames: 22 });
await s.click(myDay, { changes: 6, settleMs: 0 });
s.mark('myday');
await s.tween(12, { cur: { o: 0 } });
await s.hold(72);

const meta = s.finish();
console.log('frames', meta.frames, JSON.stringify(meta.marks));
console.log(log.join('\n'));
await browser.close();
