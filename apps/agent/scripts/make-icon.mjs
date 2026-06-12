// Generates build/icon.icns from an inline SVG so the packaged app has a real
// dock/Finder icon. On-brand per docs/design.md: black accent, cream type,
// light "Quiet Datasheet" feel. Run via `pnpm --filter @grind/agent icon`.
// Requires macOS `iconutil` (preinstalled) + the `sharp` dep (already present).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';

const execFileP = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.join(here, '..', 'build');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" rx="224" ry="224" fill="#000000"/>
  <text x="50%" y="52%" dy="0.34em" text-anchor="middle"
        font-family="Helvetica Neue, Helvetica, Arial, sans-serif"
        font-size="640" font-weight="600" fill="#f4ecd6">G</text>
</svg>`;

const SIZES = [16, 32, 64, 128, 256, 512, 1024];

async function main() {
  await fs.mkdir(buildDir, { recursive: true });
  const iconset = path.join(buildDir, 'icon.iconset');
  await fs.rm(iconset, { recursive: true, force: true });
  await fs.mkdir(iconset, { recursive: true });

  const base = await sharp(Buffer.from(svg)).resize(1024, 1024).png().toBuffer();

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
  console.log('wrote build/icon.icns + build/icon.png');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
