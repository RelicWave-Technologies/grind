import { Rng } from '../prng';

/** Packed RGB, `width * height * 3` bytes, top row first. */
export interface Rgb {
  width: number;
  height: number;
  data: Uint8Array;
}

function blank(width: number, height: number, rgb: [number, number, number]): Rgb {
  const data = new Uint8Array(width * height * 3);
  for (let i = 0; i < data.length; i += 3) {
    data[i] = rgb[0];
    data[i + 1] = rgb[1];
    data[i + 2] = rgb[2];
  }
  return { width, height, data };
}

function rect(img: Rgb, x0: number, y0: number, w: number, h: number, rgb: [number, number, number]): void {
  const xe = Math.min(img.width, x0 + w);
  const ye = Math.min(img.height, y0 + h);
  for (let y = Math.max(0, y0); y < ye; y++) {
    for (let x = Math.max(0, x0); x < xe; x++) {
      const i = (y * img.width + x) * 3;
      img.data[i] = rgb[0];
      img.data[i + 1] = rgb[1];
      img.data[i + 2] = rgb[2];
    }
  }
}

/**
 * A screenshot-like frame: flat panels, a title bar, rows of "text" (thin
 * bars), 1 px rules, saturated buttons, a gradient and a soft disc. Hard edges
 * and fine detail are what a screen has and what chroma subsampling and
 * resampling struggle with, so they are what the comparison should see.
 */
export function uiImage(width: number, height: number, seed: number): Rgb {
  const rng = new Rng(seed);
  const img = blank(width, height, [30, 30, 46]);
  const s = Math.max(1, Math.round(width / 1280));
  rect(img, 0, 0, width, 28 * s, [24, 24, 37]);
  rect(img, 0, 28 * s, 220 * s, height, [36, 38, 56]);
  for (let row = 0; row < Math.floor((height - 80 * s) / (22 * s)); row++) {
    const len = rng.int(80, 520) * s;
    const gray = rng.int(150, 235);
    rect(img, 250 * s, (60 + row * 22) * s, len, 6 * s, [gray, gray, gray]);
    if (row % 7 === 3) rect(img, 250 * s, (60 + row * 22) * s + 14 * s, width, 1, [70, 70, 100]);
  }
  const colours: Array<[number, number, number]> = [[220, 50, 60], [40, 160, 90], [60, 110, 240], [250, 190, 40]];
  colours.forEach((c, k) => rect(img, (260 + k * 140) * s, height - 70 * s, 120 * s, 36 * s, c));
  for (let y = 40 * s; y < 160 * s && y < height; y++) {
    for (let x = 10 * s; x < 200 * s && x < width; x++) {
      const i = (y * width + x) * 3;
      img.data[i] = Math.round(((x - 10 * s) / (190 * s)) * 255);
      img.data[i + 1] = Math.round(((y - 40 * s) / (120 * s)) * 255);
      img.data[i + 2] = 140;
    }
  }
  disc(img, Math.round(width * 0.8), Math.round(height * 0.45), 90 * s);
  return img;
}

function disc(img: Rgb, cx: number, cy: number, r: number): void {
  for (let y = Math.max(0, cy - r - 2); y < Math.min(img.height, cy + r + 3); y++) {
    for (let x = Math.max(0, cx - r - 2); x < Math.min(img.width, cx + r + 3); x++) {
      const d = Math.hypot(x - cx, y - cy);
      const a = Math.max(0, Math.min(1, r - d + 0.5));
      if (a === 0) continue;
      const i = (y * img.width + x) * 3;
      img.data[i] = Math.round(img.data[i]! * (1 - a) + 240 * a);
      img.data[i + 1] = Math.round(img.data[i + 1]! * (1 - a) + 120 * a);
      img.data[i + 2] = Math.round(img.data[i + 2]! * (1 - a) + 60 * a);
    }
  }
}

/** Smooth, photo-like content: three octaves of value noise per channel. */
export function photoImage(width: number, height: number, seed: number): Rgb {
  const img = blank(width, height, [0, 0, 0]);
  const grids = [0, 1, 2].map((c) => octaves(seed + c * 101));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      for (let c = 0; c < 3; c++) {
        img.data[i + c] = Math.round(255 * sample(grids[c]!, x / width, y / height));
      }
    }
  }
  return img;
}

type Octave = { n: number; cells: number[] };

function octaves(seed: number): Octave[] {
  const rng = new Rng(seed);
  return [4, 12, 40].map((n) => ({ n, cells: Array.from({ length: (n + 1) * (n + 1) }, () => rng.next()) }));
}

function sample(grid: Octave[], u: number, v: number): number {
  let total = 0;
  let weight = 0;
  grid.forEach((o, k) => {
    const w = 1 / 2 ** k;
    const fx = u * o.n;
    const fy = v * o.n;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const at = (x: number, y: number): number => o.cells[y * (o.n + 1) + x]!;
    const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
    const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
    total += (top * (1 - ty) + bottom * ty) * w;
    weight += w;
  });
  return total / weight;
}
