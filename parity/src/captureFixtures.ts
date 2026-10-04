import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';
import sharp from 'sharp';
import { Rng, seedFor } from './prng';
import { photoImage, uiImage, type Rgb } from './capture/images';

/**
 * Golden output for crates/timo-platform's screenshot pipeline, from the real
 * legacy code and the real sharp (0.33.5, libvips 8.15.3, libwebp 1.4.0):
 *
 *   tests/fixtures/capture/bgra_to_rgba_in_place.json  legacy `bgraToRgbaInPlace`
 *   tests/fixtures/capture/sharp_inside_size.json      sharp's `resize(inside, withoutEnlargement)` sizes
 *   tests/fixtures/capture/images.json + *.png + *.webp  source frames and what the legacy
 *                                                       sharp chain makes of them
 *
 *   tsx src/captureFixtures.ts            write the fixtures
 *   tsx src/captureFixtures.ts --check    regenerate in memory; exit 1 on any drift
 *
 * `--check` compares the JSON byte for byte and the images by pixel hash and
 * output size. It does not compare WebP bytes: libwebp's SIMD paths are meant to
 * be bit-exact but nothing here depends on it, so a different byte count on
 * another machine is reported as a note, not a failure.
 */
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..', 'crates', 'timo-platform', 'tests', 'fixtures', 'capture');
const QUALITY = 82;
const VERSIONS = { sharp: sharp.versions.sharp, vips: sharp.versions.vips, webp: sharp.versions.webp };
const MAX_EDGE = 2560;
const check = process.argv.includes('--check');

type CaptureModule = { bgraToRgbaInPlace: (bmp: Buffer) => Buffer };
register('./capture/hooks.mjs', import.meta.url);
const legacy = (await import(new URL('../../legacy/agent/src/main/services/capture/capture.ts', import.meta.url).href)) as CaptureModule;

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

// --- bgraToRgbaInPlace ---------------------------------------------------------

function bgraCases(): Array<{ input: { bytes: number[] }; output: number[] }> {
  const rng = new Rng(seedFor('capture/bgraToRgbaInPlace'));
  const edge: number[][] = [[], [1], [1, 2, 3], [0x10, 0x20, 0x30, 0x40], [0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255], [1, 2, 3, 4, 9, 8], [255, 255, 255, 255], [0, 0, 0, 0, 7]];
  const random = Array.from({ length: 200 }, () => Array.from({ length: rng.int(0, 96) }, () => rng.int(0, 255)));
  return [...edge, ...random].map((bytes) => {
    // Buffer.alloc is never pooled, so the Uint32Array view legacy builds is always 4-byte aligned.
    const buf = Buffer.alloc(bytes.length);
    buf.set(bytes);
    return { input: { bytes }, output: [...legacy.bgraToRgbaInPlace(buf)] };
  });
}

// --- sharp resize sizes --------------------------------------------------------

async function insideSize(width: number, height: number, edge: number): Promise<{ width: number; height: number }> {
  const { info } = await sharp({ create: { width, height, channels: 3, background: '#000' } })
    .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height };
}

async function sizeCases(): Promise<Array<{ input: { width: number; height: number; edge: number }; output: { width: number; height: number } }>> {
  const rng = new Rng(seedFor('capture/sharpInsideSize'));
  const inputs: Array<{ width: number; height: number; edge: number }> = [
    [1920, 1080], [2560, 1440], [2560, 1600], [2561, 1], [3456, 2234], [3024, 1964], [5120, 2880], [1440, 900], [1080, 1920],
    [3000, 4000], [100, 50], [1, 1], [2560, 2560], [2561, 2561], [7680, 4320], [3440, 1440], [5120, 1440], [20000, 3], [3, 20000], [4000, 4001],
  ].map(([width, height]) => ({ width: width!, height: height!, edge: MAX_EDGE }));
  for (let i = 0; i < 260; i++) {
    const wide = rng.chance(0.5);
    const long = rng.weighted<number>([[rng.int(2000, 8000), 70], [rng.int(2400, 2800), 30]]);
    const short = rng.int(1, long);
    inputs.push({ width: wide ? long : short, height: wide ? short : long, edge: rng.pick([MAX_EDGE, MAX_EDGE, 1600, 512, 64]) });
  }
  const out = [];
  for (const input of inputs) out.push({ input, output: await insideSize(input.width, input.height, input.edge) });
  return out;
}

// --- images --------------------------------------------------------------------

interface ImageMeta {
  name: string;
  width: number;
  height: number;
  sourceRgbSha256: string;
  webpWidth: number;
  webpHeight: number;
  webpBytes: number;
  webpSha256: string;
}

const SOURCES: Array<{ name: string; make: () => Rgb }> = [
  { name: 'ui_1920x1080', make: () => uiImage(1920, 1080, 11) },
  { name: 'ui_2560x1655', make: () => uiImage(2560, 1655, 12) },
  { name: 'ui_3456x2234', make: () => uiImage(3456, 2234, 13) },
  { name: 'ui_1440x2800', make: () => uiImage(1440, 2800, 14) },
  { name: 'ui_320x200', make: () => uiImage(320, 200, 15) },
  { name: 'photo_640x360', make: () => photoImage(640, 360, 21) },
  { name: 'photo_2600x900', make: () => photoImage(2600, 900, 22) },
];

/** The legacy chain from `captureNow`, fed the RGBA a `toBitmap()` swap leaves. */
async function legacyWebp(img: Rgb): Promise<{ data: Buffer; width: number; height: number }> {
  const rgba = Buffer.alloc(img.width * img.height * 4, 255);
  for (let p = 0; p < img.width * img.height; p++) {
    rgba[p * 4] = img.data[p * 3]!;
    rgba[p * 4 + 1] = img.data[p * 3 + 1]!;
    rgba[p * 4 + 2] = img.data[p * 3 + 2]!;
  }
  const { data, info } = await sharp(rgba, { raw: { width: img.width, height: img.height, channels: 4 } })
    .removeAlpha()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: QUALITY })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function pngOf(img: Rgb): Promise<Buffer> {
  return sharp(Buffer.from(img.data), { raw: { width: img.width, height: img.height, channels: 3 } }).png({ compressionLevel: 9 }).toBuffer();
}

function jsonText(value: unknown): string {
  if (Array.isArray(value)) return `[\n${value.map((v) => `  ${JSON.stringify(v)}`).join(',\n')}\n]\n`;
  return `${JSON.stringify(value, null, 2)}\n`;
}

const problems: string[] = [];
const notes: string[] = [];
const write = (name: string, content: string | Buffer): void => {
  const path = join(ROOT, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};
const compareText = (name: string, text: string): void => {
  const path = join(ROOT, name);
  if (!existsSync(path)) problems.push(`missing  ${name}`);
  else if (readFileSync(path, 'utf8') !== text) problems.push(`changed  ${name}`);
};
const emitText = (name: string, text: string): void => (check ? compareText(name, text) : write(name, text));

emitText('bgra_to_rgba_in_place.json', jsonText({ fn: 'bgraToRgbaInPlace', source: 'legacy/agent/src/main/services/capture/capture.ts', cases: bgraCases() }));
emitText('sharp_inside_size.json', jsonText({ fn: 'resize({fit:inside,withoutEnlargement})', sharp: VERSIONS, cases: await sizeCases() }));

const metas: ImageMeta[] = [];
for (const source of SOURCES) {
  const img = source.make();
  const out = await legacyWebp(img);
  const meta: ImageMeta = {
    name: source.name, width: img.width, height: img.height, sourceRgbSha256: sha256(img.data),
    webpWidth: out.width, webpHeight: out.height, webpBytes: out.data.length, webpSha256: sha256(out.data),
  };
  metas.push(meta);
  if (!check) {
    write(`images/${source.name}.png`, await pngOf(img));
    write(`images/${source.name}.sharp.webp`, out.data);
    continue;
  }
  const onDisk = join(ROOT, 'images', `${source.name}.sharp.webp`);
  if (!existsSync(onDisk)) problems.push(`missing  images/${source.name}.sharp.webp`);
  else if (sha256(readFileSync(onDisk)) !== meta.webpSha256) notes.push(`${source.name}: sharp's WebP bytes differ from the committed file (size ${out.data.length} vs ${readFileSync(onDisk).length})`);
  const pngPath = join(ROOT, 'images', `${source.name}.png`);
  if (!existsSync(pngPath)) problems.push(`missing  images/${source.name}.png`);
  else {
    const { data } = await sharp(pngPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    if (sha256(data) !== meta.sourceRgbSha256) problems.push(`changed  images/${source.name}.png (pixels differ from the generator)`);
  }
}
const metaText = jsonText({ quality: QUALITY, maxEdge: MAX_EDGE, sharp: VERSIONS, images: metas.map(({ webpSha256: _s, ...rest }) => rest) });
if (check) {
  // The committed meta carries webpSha256 for the on-disk files; compare everything else.
  const path = join(ROOT, 'images.json');
  if (!existsSync(path)) problems.push('missing  images.json');
  else if (readFileSync(path, 'utf8') !== metaText) problems.push('changed  images.json');
} else {
  write('images.json', metaText);
}

if (check) {
  for (const note of notes) console.log(`note: ${note}`);
  if (problems.length > 0) {
    console.error(`capture fixtures out of date:\n${problems.join('\n')}`);
    process.exit(1);
  }
  console.log('capture fixtures are up to date');
} else {
  console.log(`wrote capture fixtures to ${ROOT}`);
}
