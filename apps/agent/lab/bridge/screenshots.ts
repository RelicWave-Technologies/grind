/**
 * Placeholder captures: SVG data URLs that read as a desktop at thumbnail size
 * (wallpaper, menu bar, dock, an app window of one of five kinds). Deterministic
 * per id, so every surface shows the same picture for the same shot. `data:`
 * is allowed by the renderer's CSP (img-src 'self' data:).
 */

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rand = () => number;
const pick = <T,>(r: Rand, items: readonly T[]): T => items[Math.floor(r() * items.length)]!;
const n = (value: number) => Math.round(value);
const rect = (x: number, y: number, w: number, h: number, fill: string, rx = 0, extra = '') =>
  `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}"${rx ? ` rx="${rx}"` : ''} fill="${fill}"${extra}/>`;
const text = (x: number, y: number, w: number, fill: string, h = 8) => rect(x, y, w, h, fill, h / 2);

const WALLPAPERS = [
  ['#33466b', '#8e6f9c', '#e2a07a'],
  ['#1f3b4d', '#2f6f73', '#9cc5a1'],
  ['#2b2d42', '#5c4d7d', '#b18fcf'],
  ['#6d8fb3', '#a9c1d9', '#e8dcc8'],
  ['#402f2f', '#8a5a44', '#d9a066'],
] as const;
const PASTELS = ['#c5b0f4', '#f3c9b6', '#c8e6cd', '#f4ecd6', '#efd4d4', '#dbe7f5', '#dceeb1'] as const;
const KINDS = ['code', 'browser', 'sheet', 'chat', 'design'] as const;
type Kind = (typeof KINDS)[number];

function code(w: number, h: number, r: Rand): string {
  const out = [rect(0, 38, 210, h - 38, '#18191d'), rect(210, 38, w - 210, 34, '#202127')];
  for (let i = 0; i < 3; i += 1) out.push(rect(214 + i * 150, 42, 142, 30, i === 0 ? '#1e1f24' : '#26272d', 6));
  for (let i = 0; i < 20; i += 1) out.push(text(18 + (i % 4 === 0 ? 0 : 16), 62 + i * 24, 60 + r() * 90, '#3a3d46'));
  const colors = ['#c792ea', '#82aaff', '#c3e88d', '#f78c6c', '#89ddff', '#676e95'];
  for (let i = 0; i < Math.floor((h - 100) / 22); i += 1) {
    const y = 92 + i * 22;
    out.push(text(226, y, 18, '#3a3d46', 7));
    let x = 268 + Math.floor(r() * 4) * 26;
    for (let s = 0; s < 1 + Math.floor(r() * 4); s += 1) {
      const width = 28 + r() * 150;
      if (x + width > w - 30) break;
      out.push(text(x, y, width, pick(r, colors), 8));
      x += width + 10;
    }
  }
  return out.join('');
}

function browser(w: number, h: number, r: Rand): string {
  const accent = pick(r, ['#6d4aff', '#ff3d8b', '#1e8e5a', '#2563eb']);
  const out = [rect(0, 38, w, 44, '#f3f3f5'), rect(120, 47, w - 240, 26, '#ffffff', 13), text(140, 56, 220, '#c9cbd1')];
  out.push(rect(0, 82, w, 58, '#ffffff'), rect(40, 101, 90, 20, '#111111', 4));
  for (let i = 0; i < 4; i += 1) out.push(text(w - 460 + i * 100, 108, 70, '#9a9ca3'));
  out.push(rect(0, 140, w, h - 140, '#fafafa'));
  out.push(rect(60, 190, w * 0.42, 30, '#15161a', 6), rect(60, 230, w * 0.34, 30, '#15161a', 6));
  for (let i = 0; i < 4; i += 1) out.push(text(60, 286 + i * 20, w * (0.3 + r() * 0.12), '#b4b6bd'));
  out.push(rect(60, 380, 150, 40, accent, 20), rect(w * 0.55, 180, w * 0.38, 250, accent, 18, ' fill-opacity=".22"'));
  const cardW = (w - 160) / 3;
  for (let i = 0; i < 3; i += 1) {
    const x = 60 + i * (cardW + 20);
    out.push(rect(x, 470, cardW, 180, '#ffffff', 14, ' stroke="#e6e6ea"'), rect(x + 20, 490, 40, 40, pick(r, PASTELS), 10));
    for (let l = 0; l < 3; l += 1) out.push(text(x + 20, 550 + l * 22, cardW * (0.5 + r() * 0.35), '#c4c6cc'));
  }
  return out.join('');
}

function sheet(w: number, h: number, r: Rand): string {
  const out = [rect(0, 38, w, 46, '#f3f6f4'), rect(20, 50, 120, 22, '#1e8e5a', 5), rect(0, 84, w, 28, '#ffffff')];
  const cols = 10;
  const colW = (w - 40) / cols;
  const rows = Math.floor((h - 150) / 24);
  out.push(rect(20, 112, w - 40, 24, '#f1f3f4'));
  for (let c = 0; c <= cols; c += 1) out.push(rect(20 + c * colW, 112, 1, rows * 24, '#e3e6e8'));
  for (let row = 0; row <= rows; row += 1) out.push(rect(20, 112 + row * 24, w - 40, 1, '#e3e6e8'));
  for (let row = 1; row < rows; row += 1) {
    for (let c = 0; c < cols; c += 1) {
      if (r() < 0.55) out.push(text(28 + c * colW, 120 + row * 24, colW * (0.3 + r() * 0.5), c === 0 ? '#5c5f66' : '#b7bac0', 7));
    }
  }
  out.push(rect(20 + colW * 3, 112 + 24 * 5, colW, 24, 'none', 0, ' stroke="#1e8e5a" stroke-width="2"'));
  const cx = w - 360;
  out.push(rect(cx, h - 250, 320, 200, '#ffffff', 10, ' stroke="#d9dde0"'));
  for (let i = 0; i < 8; i += 1) {
    const bar = 30 + r() * 120;
    out.push(rect(cx + 24 + i * 36, h - 70 - bar, 22, bar, i % 3 === 0 ? '#1e8e5a' : '#9fd3b5', 3));
  }
  return out.join('');
}

function chat(w: number, h: number, r: Rand): string {
  const out = [rect(0, 38, 64, h - 38, '#1d2233'), rect(64, 38, 250, h - 38, '#f5f6f8')];
  for (let i = 0; i < 6; i += 1) out.push(rect(18, 60 + i * 50, 28, 28, i === 0 ? '#3370ff' : '#3a4157', 8));
  for (let i = 0; i < 10; i += 1) {
    const y = 56 + i * 58;
    if (i === 2) out.push(rect(72, y - 6, 234, 52, '#e1e9ff', 8));
    out.push(`<circle cx="98" cy="${y + 20}" r="16" fill="${pick(r, PASTELS)}"/>`, text(124, y + 8, 90 + r() * 60, '#40444f'), text(124, y + 26, 120 + r() * 50, '#b0b4bd', 7));
  }
  out.push(rect(314, 38, w - 314, 54, '#ffffff'), text(338, 60, 180, '#2a2d35', 10), rect(314, 92, w - 314, 1, '#e8e9ec'));
  let y = 120;
  for (let i = 0; i < 6 && y < h - 150; i += 1) {
    out.push(`<circle cx="354" cy="${y + 16}" r="16" fill="${pick(r, PASTELS)}"/>`, text(382, y + 2, 110, '#2a2d35', 9));
    const lines = 1 + Math.floor(r() * 3);
    for (let l = 0; l < lines; l += 1) out.push(text(382, y + 22 + l * 18, (w - 480) * (0.35 + r() * 0.5), '#9ea3ad', 8));
    y += 50 + lines * 18;
  }
  out.push(rect(334, h - 86, w - 368, 60, '#ffffff', 12, ' stroke="#dcdfe4"'));
  return out.join('');
}

function design(w: number, h: number, r: Rand): string {
  const out = [rect(0, 38, 220, h - 38, '#fafafa'), rect(w - 240, 38, 240, h - 38, '#fafafa'), rect(220, 38, w - 460, h - 38, '#e5e5e5')];
  for (let i = 0; i < 18; i += 1) out.push(text(20 + (i % 3) * 14, 60 + i * 24, 80 + r() * 70, i === 4 ? '#6d4aff' : '#b9b9be'));
  for (let i = 0; i < 12; i += 1) out.push(text(w - 220, 64 + i * 34, 60 + r() * 120, '#c3c3c8'), rect(w - 70, 60 + i * 34, 50, 16, '#ffffff', 4, ' stroke="#dedee2"'));
  const boardW = (w - 540) / 2;
  for (let b = 0; b < 2; b += 1) {
    const x = 260 + b * (boardW + 20);
    out.push(rect(x, 90, boardW, h - 150, '#ffffff'), text(x, 76, 90, '#8d8d92', 7));
    for (let s = 0; s < 5; s += 1) {
      const sx = x + 20 + r() * (boardW - 160);
      const sy = 120 + r() * (h - 360);
      out.push(s % 2 === 0
        ? rect(sx, sy, 80 + r() * 90, 50 + r() * 90, pick(r, PASTELS), 14)
        : `<circle cx="${n(sx + 40)}" cy="${n(sy + 40)}" r="${n(24 + r() * 30)}" fill="${pick(r, PASTELS)}"/>`);
    }
  }
  return out.join('');
}

const CONTENT: Record<Kind, (w: number, h: number, r: Rand) => string> = { code, browser, sheet, chat, design };

function appWindow(x: number, y: number, w: number, h: number, dark: boolean, body: string): string {
  const bar = dark ? '#2a2b31' : '#ececef';
  return `<g transform="translate(${n(x)} ${n(y)})">`
    + rect(0, 0, w, h, dark ? '#1e1f24' : '#ffffff', 12, ' filter="url(#shadow)"')
    + `<svg width="${n(w)}" height="${n(h)}"><clipPath id="c${n(x)}"><rect width="${n(w)}" height="${n(h)}" rx="12"/></clipPath><g clip-path="url(#c${n(x)})">`
    + rect(0, 0, w, 38, bar) + body
    + '</g></svg>'
    + `<circle cx="20" cy="19" r="6" fill="#ff5f57"/><circle cx="40" cy="19" r="6" fill="#febc2e"/><circle cx="60" cy="19" r="6" fill="#28c840"/>`
    + '</g>';
}

function desktopSvg(id: string): string {
  const r = random(hash(id));
  const [a, b, c] = pick(r, WALLPAPERS);
  const kind = pick(r, KINDS);
  const parts: string[] = [
    `<defs><linearGradient id="wall" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset=".55" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></linearGradient>`
      + '<filter id="shadow" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="14" stdDeviation="18" flood-opacity=".35"/></filter></defs>',
    rect(0, 0, 1440, 900, 'url(#wall)'),
  ];
  // A window behind, then the app in focus.
  const backX = 760 + r() * 160;
  parts.push(appWindow(backX, 110 + r() * 60, 600, 440, false, rect(0, 38, 600, 402, '#fbfbfc') + Array.from({ length: 12 }, (_, i) => text(28, 70 + i * 26, 200 + r() * 300, '#d0d2d8')).join('')));
  const w = 1030 + r() * 130;
  parts.push(appWindow(50 + r() * 120, 56 + r() * 40, w, 690, kind === 'code', CONTENT[kind](w, 690, r)));
  // Menu bar.
  parts.push(rect(0, 0, 1440, 28, '#ffffff', 0, ' fill-opacity=".62"'), rect(18, 8, 12, 13, '#111111', 3));
  for (let i = 0; i < 6; i += 1) parts.push(text(48 + i * 74, 10, i === 0 ? 50 : 38 + r() * 20, '#1c1c1e', 8));
  for (let i = 0; i < 5; i += 1) parts.push(text(1160 + i * 38, 10, 20, '#1c1c1e', 8));
  parts.push(text(1360, 10, 64, '#1c1c1e', 8));
  // Dock.
  parts.push(rect(420, 824, 600, 64, '#ffffff', 20, ' fill-opacity=".38"'));
  for (let i = 0; i < 11; i += 1) parts.push(rect(434 + i * 53, 834, 44, 44, pick(r, ['#3370ff', '#ff5f57', '#28c840', '#febc2e', '#6d4aff', '#111111', '#ff3d8b', '#34c3ff']), 11));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 900" width="1440" height="900">${parts.join('')}</svg>`;
}

const cache = new Map<string, string>();

export function screenshotDataUrl(id: string): string {
  let url = cache.get(id);
  if (!url) {
    url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(desktopSvg(id))}`;
    cache.set(id, url);
  }
  return url;
}

export function avatarDataUrl(name: string): string {
  const initials = name.split(/\s+/).map((part) => part[0] ?? '').join('').slice(0, 2).toUpperCase();
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">'
    + '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c5cff"/><stop offset="1" stop-color="#ff7ab0"/></linearGradient></defs>'
    + '<rect width="128" height="128" fill="url(#g)"/>'
    + `<text x="64" y="64" dy=".35em" text-anchor="middle" font-family="-apple-system, system-ui, sans-serif" font-size="52" font-weight="600" fill="#ffffff">${initials}</text>`
    + '</svg>';
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
