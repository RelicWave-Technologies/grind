// Generates every Timo brand asset from the one logo mark so the dashboard,
// the agent's chrome, the app icon and the tray icons stay in sync
// (DESIGN.md §9 The logo).
// Requires macOS `iconutil` (preinstalled) + the `sharp` dep (already present).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';

const execFileP = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const agentDir = path.join(here, '..');
const repoRoot = path.join(agentDir, '..', '..');
const buildDir = path.join(agentDir, 'build');
const agentAssetsDir = path.join(agentDir, 'src', 'renderer', 'assets');
const dashboardBrandDir = path.join(repoRoot, 'apps', 'dashboard', 'public', 'brand');
const logoSvgPath = path.join(agentAssetsDir, 'timo-logo.svg');

const SIZES = [16, 32, 64, 128, 256, 512, 1024];
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
  await fs.mkdir(buildDir, { recursive: true });
  await fs.mkdir(path.join(buildDir, 'icons'), { recursive: true });
  await fs.mkdir(dashboardBrandDir, { recursive: true });

  const logoSvg = await fs.readFile(logoSvgPath, 'utf8');
  await fs.writeFile(path.join(dashboardBrandDir, 'timo-logo.svg'), logoSvg);
  await renderPng(logoSvg, 512, path.join(dashboardBrandDir, 'timo-logo.png'));

  // The favicon is the app icon, so a browser tab and the Dock match.
  await fs.writeFile(path.join(buildDir, 'icon.svg'), appIconSvg);
  await fs.writeFile(path.join(dashboardBrandDir, 'timo-icon.svg'), appIconSvg);
  await renderPng(appIconSvg, 512, path.join(dashboardBrandDir, 'timo-icon.png'));

  const base = await sharp(Buffer.from(appIconSvg), { density: 144 })
    .resize(1024, 1024, { fit: 'contain', background: TRANSPARENT })
    .png()
    .toBuffer();
  const iconset = path.join(buildDir, 'icon.iconset');
  await fs.rm(iconset, { recursive: true, force: true });
  await fs.mkdir(iconset, { recursive: true });

  // Apple iconset naming: icon_<pt>x<pt>.png and @2x variants.
  for (const size of SIZES) {
    const png = await sharp(base).resize(size, size).png().toBuffer();
    if (size <= 512) await fs.writeFile(path.join(iconset, `icon_${size}x${size}.png`), png);
    if (size >= 32) {
      const half = size / 2;
      await fs.writeFile(path.join(iconset, `icon_${half}x${half}@2x.png`), png);
    }
  }

  await execFileP('iconutil', ['-c', 'icns', iconset, '-o', path.join(buildDir, 'icon.icns')]);
  await fs.rm(iconset, { recursive: true, force: true });
  // Also drop a 512 png for any non-mac packaging that wants a raster icon.
  await sharp(base).resize(512, 512).png().toFile(path.join(buildDir, 'icon.png'));

  await renderPng(trayTemplateSvg, 16, path.join(buildDir, 'icons', 'trayTemplate.png'));
  await renderPng(trayTemplateSvg, 32, path.join(buildDir, 'icons', 'trayTemplate@2x.png'));
  await renderPng(trayColourSvg, 16, path.join(buildDir, 'icons', 'tray.png'));

  console.log('wrote the Timo logo, favicon, app icon and tray icons');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
