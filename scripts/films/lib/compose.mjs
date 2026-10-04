// compose.mjs — renders a composition (compose/<film>.html) frame by frame, then encodes it.
//
//   node scripts/films/lib/compose.mjs hero                  every frame, then MP4 + poster
//   node scripts/films/lib/compose.mjs hero --at 0 120 400   only these frames, to check them
//
// A composition exposes window.FILM = { frames, poster, loop } and an async window.render(f)
// that draws frame f and resolves once every image in it has decoded. It is served from the
// repo root, so it can link the design system's own tokens and fonts (packages/design).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const films = path.resolve(here, '..');
const repo = path.resolve(films, '../..');
const WORK = process.env.TIMO_FILM_WORK ?? '/tmp/timo-film';
const DEST = path.join(repo, 'apps/dashboard/public/films');
const FINISH = path.join(process.env.HOME, '.claude/skills/app-walkthrough-video/scripts/finish.py');

const [film, ...rest] = process.argv.slice(2);
const atIdx = rest.indexOf('--at');
const only = atIdx >= 0 ? rest.slice(atIdx + 1).map(Number) : null;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
// Module scripts do not load from file://, so the page is served from a made-up host: repo
// files by their path under the repo root, plate frames by their absolute /tmp path.
await page.route('http://film.local/**', (route) => {
  const p = decodeURIComponent(new URL(route.request().url()).pathname);
  const file = p.startsWith('/tmp/') || p.startsWith('/private/') ? p : path.join(repo, p);
  if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: 'missing ' + p });
  return route.fulfill({ path: file });
});
await page.goto(`http://film.local/${path.relative(repo, path.join(films, 'compose', `${film}.html`))}`);
await page.waitForFunction(() => window.ready === true);
const FILM = await page.evaluate(() => window.FILM);

const out = only ? `${WORK}/check` : `${WORK}/render/${film}/frames`;
if (!only) fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const list = only ?? Array.from({ length: FILM.frames }, (_, i) => i);
const t0 = Date.now();
for (const f of list) {
  await page.evaluate((n) => window.render(n), f);
  const name = only ? `${film}-${String(f).padStart(5, '0')}.jpg` : `${String(f).padStart(5, '0')}.jpg`;
  await page.screenshot({ path: path.join(out, name), type: 'jpeg', quality: 94 });
}
await browser.close();
console.log(`${film}: ${list.length} frames in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));

if (!only) {
  const vid = path.dirname(out);
  fs.writeFileSync(path.join(vid, 'cuts.json'), JSON.stringify({ frames: FILM.frames, cuts: [], fps: 30 }));
  execFileSync('python3', [FINISH, vid, '--name', `timo-${film}`, '--loop', String(FILM.loop ?? 16), '--crf', '24'], { stdio: 'inherit' });
  // The poster is a chosen frame, not frame 0: frame 0 is the quiet start of the loop.
  execFileSync('python3', [
    '-c',
    `from PIL import Image
Image.open("${vid}/final/${String(FILM.poster).padStart(5, '0')}.jpg").convert("RGB").save("${vid}/timo-${film}-poster.webp", "WEBP", quality=84, method=6)`,
  ]);
  fs.mkdirSync(DEST, { recursive: true });
  for (const f of [`timo-${film}.mp4`, `timo-${film}-poster.webp`]) fs.copyFileSync(path.join(vid, f), path.join(DEST, f));
  console.log(`copied to ${DEST}`);
}
