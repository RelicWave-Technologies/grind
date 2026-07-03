// Generates all Timo brand assets from one transparent SVG source so the
// dashboard, agent chrome, app icon, and tray icons stay in sync.
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
const sourceSvgPath = path.join(agentAssetsDir, 'timo-mascot.svg');
const agentMascotPngPath = path.join(agentAssetsDir, 'timo-mascot.png');

const SIZES = [16, 32, 64, 128, 256, 512, 1024];
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

const trayTemplateSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <path fill="#000" d="M8 33c0-10 8-19 20-21 2-7 8-12 13-10 4 2 4 8 1 13 5-2 11-1 13 4 2 4-1 9-6 11 4 3 7 7 7 12 0 10-11 18-24 18S8 52 8 42v-9Z"/>
  <circle cx="25" cy="31" r="5" fill="#000"/>
  <circle cx="40" cy="31" r="5" fill="#000"/>
</svg>`;

async function renderPng(input, size, output) {
  await sharp(input)
    .resize(size, size, { fit: 'contain', background: TRANSPARENT })
    .png()
    .toFile(output);
}

async function main() {
  await fs.mkdir(buildDir, { recursive: true });
  await fs.mkdir(path.join(buildDir, 'icons'), { recursive: true });
  await fs.mkdir(dashboardBrandDir, { recursive: true });

  const sourceSvg = await fs.readFile(sourceSvgPath);
  await fs.writeFile(path.join(buildDir, 'icon.svg'), sourceSvg);
  await fs.writeFile(path.join(dashboardBrandDir, 'timo-mascot.svg'), sourceSvg);
  await fs.writeFile(path.join(dashboardBrandDir, 'timo-icon.svg'), sourceSvg);

  await renderPng(sourceSvg, 512, agentMascotPngPath);
  await renderPng(sourceSvg, 512, path.join(dashboardBrandDir, 'timo-mascot.png'));
  await renderPng(sourceSvg, 512, path.join(dashboardBrandDir, 'timo-icon.png'));

  const base = await sharp(sourceSvg)
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

  await renderPng(Buffer.from(trayTemplateSvg), 16, path.join(buildDir, 'icons', 'trayTemplate.png'));
  await renderPng(Buffer.from(trayTemplateSvg), 32, path.join(buildDir, 'icons', 'trayTemplate@2x.png'));
  await renderPng(sourceSvg, 16, path.join(buildDir, 'icons', 'tray.png'));

  console.log('wrote synced Timo mascot, favicon, app icon, and tray assets');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
