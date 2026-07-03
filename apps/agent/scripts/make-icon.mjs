// Generates build/icon.icns from the Timo mascot so the packaged app has the
// same teddy mark used in the dashboard and agent chrome.
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
const mascotPath = path.join(here, '..', 'src', 'renderer', 'assets', 'timo-mascot.png');

const SIZES = [16, 32, 64, 128, 256, 512, 1024];

async function main() {
  await fs.mkdir(buildDir, { recursive: true });
  const mascot = await sharp(mascotPath).resize(900, 900, { fit: 'contain', background: '#ffffff' }).png().toBuffer();
  const base = await sharp({
    create: { width: 1024, height: 1024, channels: 4, background: '#ffffff' },
  })
    .composite([{ input: mascot, gravity: 'center' }])
    .png()
    .toBuffer();
  const svgImage = base.toString('base64');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect width="1024" height="1024" rx="224" fill="#dceeb1"/><image href="data:image/png;base64,${svgImage}" width="1024" height="1024"/></svg>\n`;
  await fs.writeFile(path.join(buildDir, 'icon.svg'), svg);
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
  console.log('wrote Timo build/icon.svg + build/icon.icns + build/icon.png');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
