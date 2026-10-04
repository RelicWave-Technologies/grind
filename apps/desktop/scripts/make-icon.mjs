// Generates the desktop app's brand assets from the one logo mark so the app
// icon, the tray icons and the Tauri icon set stay in sync with the dashboard
// (DESIGN.md §9 The logo). Writes only under apps/desktop: src-tauri/icons
// (Tauri icon set: icon.icns, icon.ico, PNGs) and src-tauri/icons/tray (the
// menu-bar / system-tray images). Needs the `sharp` dep and the Tauri CLI
// (`@tauri-apps/cli`), which builds the .icns/.ico on any host.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';

const execFileP = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.join(here, '..');
const repoRoot = path.join(desktopDir, '..', '..');
const iconsDir = path.join(desktopDir, 'src-tauri', 'icons');
const trayDir = path.join(iconsDir, 'tray');
const tauriCli = path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri');

// `tauri icon` also emits mobile and Microsoft Store assets Timo does not ship.
const KEEP = new Set(['32x32.png', '128x128.png', '128x128@2x.png', 'icon.icns', 'icon.ico', 'icon.png', 'tray']);
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

// DESIGN.md `brand`, `brand-hi`, `ink` and `dark`. The mark's own SVG carries the same values.
const BRAND = '#2F6FD0';
const BRAND_HI = '#5B93E3';
const INK = '#111111';
const DARK = '#0F1216';

/**
 * The mark on a 64 grid: the T's bar and stem in `body`, the moment at the
 * end of the bar in `moment`. On light it is ink + brand; on the dark tile,
 * white + brand-hi, which holds its contrast on near-black.
 */
function mark(body, moment) {
  return `
    <rect x="7" y="10" width="30" height="12" rx="6" fill="${body}"/>
    <rect x="41" y="10" width="16" height="12" rx="6" fill="${moment}"/>
    <rect x="26" y="26" width="12" height="29" rx="6" fill="${body}"/>`;
}

/**
 * The app icon: a `dark` tile on Apple's 1024 grid (an 824 body with a 100
 * margin, so the Dock sizes it like every other app), lit by a hairline of
 * white along its top edge, with the mark in white and brand-hi at 56% of the
 * body. Black and blue: the T is black, now is blue (DESIGN.md §9).
 */
const appIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2A2D31"/>
      <stop offset="1" stop-color="${DARK}"/>
    </linearGradient>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#tile)"/>
  <rect x="100.5" y="100.5" width="823" height="823" rx="184.5" fill="none" stroke="#FFFFFF" stroke-opacity="0.08"/>
  <g transform="translate(512 512) scale(7.2) translate(-32 -32)">${mark('#FFFFFF', BRAND_HI)}</g>
</svg>`;

/**
 * The macOS menu-bar template: the mark redrawn on a 16 grid so every edge
 * lands on whole pixels at 1x and 2x. Black; the system tints it, so the
 * moment is set apart by a gap rather than a colour.
 */
const trayTemplateSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
  <rect x="1" y="2" width="9" height="4" rx="2" fill="#000"/>
  <rect x="11" y="2" width="4" height="4" rx="2" fill="#000"/>
  <rect x="6" y="7" width="4" height="8" rx="2" fill="#000"/>
</svg>`;

// Windows/Linux trays are not tinted by the system: the same grid in ink with a brand moment.
const trayColourSvg = trayTemplateSvg
  .replace('fill="#000"', `fill="${INK}"`)
  .replace('fill="#000"', `fill="${BRAND}"`)
  .replace('fill="#000"', `fill="${INK}"`);

// Rasterise at twice the target from the SVG's own width, so small outputs
// (the 16px tray) are drawn crisp instead of scaled down from a blur.
async function renderPng(input, size, output) {
  const intrinsic = Number(/width="(\d+)"/.exec(input)?.[1] ?? 64);
  await sharp(Buffer.from(input), { density: Math.max(72, Math.ceil((72 * size * 2) / intrinsic)) })
    .resize(size, size, { fit: 'contain', background: TRANSPARENT })
    .png()
    .toFile(output);
}

async function main() {
  await fs.mkdir(trayDir, { recursive: true });

  // The app icon at 1024: the Tauri CLI derives icon.icns, icon.ico and the PNGs.
  const source = path.join(iconsDir, 'source-1024.png');
  await sharp(Buffer.from(appIconSvg), { density: 144 })
    .resize(1024, 1024, { fit: 'contain', background: TRANSPARENT })
    .png()
    .toFile(source);
  await execFileP(tauriCli, ['icon', source, '--output', iconsDir]);
  await fs.rm(source, { force: true });
  for (const entry of await fs.readdir(iconsDir)) {
    if (!KEEP.has(entry)) await fs.rm(path.join(iconsDir, entry), { recursive: true, force: true });
  }

  await renderPng(trayTemplateSvg, 16, path.join(trayDir, 'trayTemplate.png'));
  await renderPng(trayTemplateSvg, 32, path.join(trayDir, 'trayTemplate@2x.png'));
  await renderPng(trayColourSvg, 16, path.join(trayDir, 'tray.png'));

  console.log('wrote the Timo app icon set and tray icons to src-tauri/icons');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
