/**
 * Local placeholder imagery: avatars, app icons and plausible desktop
 * screenshots, all drawn as SVG so nothing depends on a remote host.
 *
 * Screenshots are served as blob: URLs (short strings, cheap to poll) and
 * cached per variant; avatars and icons are small data: URLs that can live in
 * the persisted store.
 */
import { rngFor, type Rng } from './rng';

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// ---------------------------------------------------------------------------
// Avatars
// ---------------------------------------------------------------------------

const AVATAR_BG: ReadonlyArray<readonly [string, string]> = [
  ['#F6D365', '#FDA085'],
  ['#A1C4FD', '#C2E9FB'],
  ['#D4FC79', '#96E6A1'],
  ['#FBC2EB', '#A6C1EE'],
  ['#FFD1A9', '#FF9A8B'],
  ['#C1DFC4', '#DEECDD'],
  ['#E0C3FC', '#8EC5FC'],
];
const SKIN = ['#F1C7A5', '#E0AC89', '#C68863', '#A86B4A', '#8D5A3B', '#F5D5BE'];
const HAIR = ['#2B1B12', '#3B2416', '#1C1C1C', '#6B4226', '#A8743A', '#4A3B35'];
const SHIRT = ['#2F3E46', '#355070', '#6D597A', '#B56576', '#1D3557', '#3A5A40', '#264653'];

export function avatarDataUrl(seed: string): string {
  const r = rngFor('avatar', seed);
  const [bg1, bg2] = r.pick(AVATAR_BG);
  const skin = r.pick(SKIN);
  const hair = r.pick(HAIR);
  const shirt = r.pick(SHIRT);
  const hairStyle = r.int(0, 3);
  const hairPath = [
    'M20 27c0-8 5-13 12-13s12 5 12 13c-3-4-7-6-12-6s-9 2-12 6z',
    'M19 30c-1-10 5-16 13-16s14 6 13 16c-2-5-4-8-7-9-4 2-10 3-19 9z',
    'M18 34c-2-12 4-20 14-20s16 8 14 20l-3-1c0-7-4-11-11-11s-11 4-11 11z',
    'M21 26c1-7 5-11 11-11s10 4 11 11c-4-2-7-3-11-3s-7 1-11 3z M40 18c3 1 5 3 6 6',
  ][hairStyle]!;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bg1}"/><stop offset="1" stop-color="${bg2}"/></linearGradient></defs><rect width="64" height="64" fill="url(#g)"/><path d="M10 64c2-12 11-18 22-18s20 6 22 18z" fill="${shirt}"/><rect x="27" y="38" width="10" height="10" rx="4" fill="${skin}"/><circle cx="32" cy="29" r="11" fill="${skin}"/><path d="${hairPath}" fill="${hair}"/></svg>`;
  return svgDataUrl(svg);
}

// ---------------------------------------------------------------------------
// App icons (only a few apps get one, the rest use the letter fallback)
// ---------------------------------------------------------------------------

const ICONS: Record<string, string> = {
  Figma:
    '<rect width="32" height="32" rx="7" fill="#1E1E1E"/><circle cx="19" cy="16" r="3.2" fill="#1ABCFE"/><rect x="10" y="6.5" width="6.4" height="6.4" rx="3.2" fill="#F24E1E"/><rect x="16" y="6.5" width="6.4" height="6.4" rx="3.2" fill="#FF7262"/><rect x="10" y="12.8" width="6.4" height="6.4" rx="3.2" fill="#A259FF"/><rect x="10" y="19.1" width="6.4" height="6.4" rx="3.2" fill="#0ACF83"/>',
  'Visual Studio Code':
    '<rect width="32" height="32" rx="7" fill="#0065A9"/><path d="M21.5 6 12 15 7.5 11.5 6 12.5v7l1.5 1L12 17l9.5 9 4.5-2V8z" fill="#fff" opacity=".92"/><path d="M21.5 11v10l-6.5-5z" fill="#0065A9"/>',
  Slack:
    '<rect width="32" height="32" rx="7" fill="#fff"/><rect x="8" y="13" width="10" height="3.2" rx="1.6" fill="#36C5F0"/><rect x="13" y="8" width="3.2" height="10" rx="1.6" fill="#2EB67D"/><rect x="14" y="16" width="10" height="3.2" rx="1.6" fill="#ECB22E"/><rect x="15.8" y="14" width="3.2" height="10" rx="1.6" fill="#E01E5A"/>',
  Lark:
    '<rect width="32" height="32" rx="7" fill="#fff"/><path d="M7 12c5 1 9 4 12 8l-5 5c-3-4-5-8-7-13z" fill="#00D6B9"/><path d="M12 7h9c1 2 2 4 2 7l-4 3c-2-4-4-7-7-10z" fill="#3370FF"/><path d="M14 22c4-2 8-4 12-9-1 6-4 11-10 12z" fill="#133C9A"/>',
  Notion:
    '<rect width="32" height="32" rx="7" fill="#fff" stroke="#E5E5E5"/><path d="M10 8.5h9.5L23 11v13H10z" fill="#fff" stroke="#111" stroke-width="1.6"/><path d="M13.5 13v8M13.5 13l5.5 8M19 13v8" stroke="#111" stroke-width="1.7" fill="none"/>',
  'zoom.us':
    '<rect width="32" height="32" rx="7" fill="#2D8CFF"/><rect x="7" y="11" width="13" height="10" rx="2.5" fill="#fff"/><path d="M21 14.5 25.5 12v8L21 17.5z" fill="#fff"/>',
};

export function appIconDataUrl(app: string): string | null {
  const body = ICONS[app];
  if (!body) return null;
  return svgDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${body}</svg>`);
}

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

export type ScreenKind = 'design' | 'code' | 'terminal' | 'browser' | 'chat' | 'sheet' | 'call' | 'doc';

const W = 1440;
const H = 900;

function lines(r: Rng, x: number, y: number, maxW: number, count: number, gap: number, colors: readonly string[], h = 7): string {
  let out = '';
  for (let i = 0; i < count; i++) {
    const indent = r.chance(0.35) ? r.int(1, 3) * 18 : 0;
    const w = r.range(0.25, 1) * (maxW - indent);
    out += `<rect x="${x + indent}" y="${y + i * gap}" width="${w.toFixed(0)}" height="${h}" rx="${h / 2}" fill="${r.pick(colors)}"/>`;
  }
  return out;
}

function windowFrame(inner: string, titleBg: string, title: string): string {
  return `<g><rect x="70" y="52" width="1300" height="820" rx="12" fill="#000" opacity=".25" transform="translate(0 6)"/><rect x="70" y="52" width="1300" height="820" rx="12" fill="${titleBg}"/><circle cx="92" cy="70" r="6" fill="#FF5F57"/><circle cx="112" cy="70" r="6" fill="#FEBC2E"/><circle cx="132" cy="70" r="6" fill="#28C840"/><text x="720" y="75" font-family="-apple-system,Segoe UI,sans-serif" font-size="13" fill="#9A9A9A" text-anchor="middle">${title}</text><svg x="70" y="88" width="1300" height="784">${inner}</svg></g>`;
}

function designScreen(r: Rng): string {
  const accent = r.pick(['#7B61FF', '#FF7262', '#0ACF83', '#1ABCFE', '#F59E0B']);
  let frames = '';
  const count = r.int(2, 3);
  for (let i = 0; i < count; i++) {
    const fx = 300 + i * 250 + r.int(-10, 10);
    const fy = 90 + r.int(0, 40);
    frames += `<rect x="${fx}" y="${fy}" width="220" height="440" rx="6" fill="#fff"/><rect x="${fx + 14}" y="${fy + 16}" width="192" height="120" rx="8" fill="${r.pick(['#FDE68A', '#C7D2FE', '#FBCFE8', '#A7F3D0', '#FED7AA'])}"/>${lines(r, fx + 14, fy + 156, 192, 6, 18, ['#D4D4D8', '#E4E4E7'], 8)}<rect x="${fx + 14}" y="${fy + 380}" width="110" height="30" rx="15" fill="${accent}"/>`;
  }
  const sel = 300 + r.int(0, count - 1) * 250;
  return `<rect width="1300" height="784" fill="#E8E8EA"/><rect width="1300" height="40" fill="#2C2C2C"/><rect x="10" y="10" width="20" height="20" rx="4" fill="${accent}"/><rect width="240" height="784" y="40" fill="#fff"/>${lines(r, 20, 64, 200, 22, 26, ['#D4D4D8', '#A1A1AA'])}<rect x="1040" y="40" width="260" height="744" fill="#fff"/>${lines(r, 1060, 64, 220, 16, 30, ['#D4D4D8', '#E4E4E7'])}${frames}<rect x="${sel - 2}" y="88" width="224" height="486" fill="none" stroke="#18A0FB" stroke-width="2"/>`;
}

function codeScreen(r: Rng): string {
  const palette = ['#569CD6', '#CE9178', '#9CDCFE', '#6A9955', '#C586C0', '#DCDCAA', '#D4D4D4', '#4EC9B0'];
  let code = '';
  let y = 60;
  for (let i = 0; i < 26; i++) {
    const indent = r.int(0, 3) * 22;
    let x = 320 + indent;
    const tokens = r.int(1, 5);
    for (let t = 0; t < tokens; t++) {
      const w = r.int(24, 110);
      if (x + w > 1260) break;
      code += `<rect x="${x}" y="${y}" width="${w}" height="8" rx="3" fill="${r.pick(palette)}"/>`;
      x += w + 8;
    }
    code += `<rect x="276" y="${y}" width="16" height="8" rx="2" fill="#5A5A5A"/>`;
    y += 20;
  }
  return `<rect width="1300" height="784" fill="#1E1E1E"/><rect width="48" height="784" fill="#333"/><rect x="48" width="210" height="784" fill="#252526"/>${lines(r, 66, 24, 170, 24, 22, ['#8B8B8B', '#6B6B6B', '#C5C5C5'], 7)}<rect x="258" width="1042" height="34" fill="#252526"/><rect x="258" width="160" height="34" fill="#1E1E1E"/><rect x="272" y="13" width="110" height="8" rx="3" fill="#C5C5C5"/>${code}<rect x="258" y="590" width="1042" height="194" fill="#181818"/><rect x="258" y="590" width="1042" height="1" fill="#3C3C3C"/>${lines(r, 276, 612, 700, 7, 22, ['#23D18B', '#CCCCCC', '#3B8EEA'], 7)}<rect y="764" width="1300" height="20" fill="#007ACC"/>`;
}

function terminalScreen(r: Rng): string {
  return `<rect width="1300" height="784" fill="#0F1115"/>${lines(r, 24, 28, 1100, 34, 22, ['#39D353', '#E6EDF3', '#7D8590', '#E3B341', '#58A6FF'], 8)}<rect x="24" y="${28 + 34 * 22}" width="12" height="16" fill="#E6EDF3"/>`;
}

function browserScreen(r: Rng): string {
  const brand = r.pick(['#FF7A59', '#0A66C2', '#111827', '#EA4335', '#7C3AED', '#0F9D58']);
  let cards = '';
  for (let i = 0; i < 3; i++) {
    const cx = 100 + i * 380;
    cards += `<rect x="${cx}" y="470" width="340" height="250" rx="12" fill="#fff" stroke="#E5E7EB"/><rect x="${cx + 20}" y="490" width="300" height="110" rx="8" fill="${r.pick(['#F3F4F6', '#EEF2FF', '#FEF3C7', '#ECFDF5'])}"/>${lines(r, cx + 20, 620, 300, 3, 22, ['#9CA3AF', '#D1D5DB'], 8)}`;
  }
  return `<rect width="1300" height="784" fill="#F9FAFB"/><rect width="1300" height="40" fill="#DEE1E6"/><rect x="12" y="8" width="210" height="32" rx="8" fill="#F9FAFB"/><rect x="232" y="14" width="150" height="20" rx="6" fill="#CDD1D6"/><rect width="1300" height="36" y="40" fill="#F9FAFB"/><rect x="90" y="46" width="760" height="24" rx="12" fill="#E8EAED"/><rect y="76" width="1300" height="56" fill="#fff" stroke="#E5E7EB"/><rect x="100" y="94" width="120" height="20" rx="4" fill="${brand}"/>${lines(r, 700, 98, 90, 1, 0, ['#9CA3AF'], 10)}<rect x="1080" y="90" width="120" height="30" rx="15" fill="${brand}"/><rect x="100" y="170" width="${r.int(480, 640)}" height="36" rx="8" fill="#111827"/><rect x="100" y="220" width="${r.int(360, 520)}" height="36" rx="8" fill="#111827"/>${lines(r, 100, 290, 560, 4, 24, ['#6B7280', '#9CA3AF'], 10)}<rect x="100" y="400" width="160" height="40" rx="20" fill="${brand}"/><rect x="780" y="160" width="420" height="270" rx="16" fill="${brand}" opacity=".18"/>${cards}`;
}

function chatScreen(r: Rng): string {
  const side = r.pick(['#3F0E40', '#1F2A44', '#1456F0', '#0B3D2E']);
  let msgs = '';
  for (let i = 0; i < 9; i++) {
    const y = 70 + i * 74;
    msgs += `<rect x="300" y="${y}" width="36" height="36" rx="8" fill="${r.pick(['#F59E0B', '#10B981', '#6366F1', '#EF4444', '#0EA5E9'])}"/><rect x="350" y="${y + 2}" width="${r.int(80, 150)}" height="9" rx="4" fill="#1F2937"/>${lines(r, 350, y + 22, 820, r.int(1, 2), 18, ['#6B7280', '#9CA3AF'], 8)}`;
  }
  return `<rect width="1300" height="784" fill="#fff"/><rect width="260" height="784" fill="${side}"/>${lines(r, 22, 30, 200, 22, 28, ['rgba(255,255,255,.55)', 'rgba(255,255,255,.3)'], 9)}<rect x="260" width="1040" height="50" fill="#fff" stroke="#E5E7EB"/><rect x="290" y="18" width="160" height="12" rx="4" fill="#111827"/>${msgs}<rect x="290" y="712" width="980" height="52" rx="10" fill="#fff" stroke="#D1D5DB"/>`;
}

function sheetScreen(r: Rng): string {
  let grid = '';
  for (let row = 0; row < 26; row++) {
    const y = 110 + row * 25;
    grid += `<rect x="0" y="${y}" width="1300" height="1" fill="#E2E3E3"/>`;
    for (let col = 0; col < 9; col++) {
      if (r.chance(0.72)) grid += `<rect x="${60 + col * 136}" y="${y + 9}" width="${r.int(30, 100)}" height="7" rx="2" fill="${row === 0 ? '#188038' : '#5F6368'}"/>`;
    }
  }
  for (let col = 0; col < 10; col++) grid += `<rect x="${48 + col * 136}" y="110" width="1" height="650" fill="#E2E3E3"/>`;
  return `<rect width="1300" height="784" fill="#fff"/><rect width="1300" height="64" fill="#F9FBFD"/><rect x="20" y="16" width="30" height="36" rx="4" fill="#0F9D58"/><rect x="64" y="20" width="220" height="12" rx="4" fill="#3C4043"/><rect y="64" width="1300" height="46" fill="#EDF2FA"/>${grid}`;
}

function callScreen(r: Rng): string {
  let tiles = '';
  for (let i = 0; i < 4; i++) {
    const x = 30 + (i % 2) * 625;
    const y = 30 + Math.floor(i / 2) * 340;
    const tone = r.pick(['#374151', '#1F2937', '#312E81', '#064E3B', '#3F3F46']);
    tiles += `<rect x="${x}" y="${y}" width="610" height="325" rx="12" fill="${tone}"/><circle cx="${x + 305}" cy="${y + 150}" r="58" fill="${r.pick(SKIN)}"/><path d="M${x + 215} ${y + 325}c10-60 50-90 90-90s80 30 90 90z" fill="${r.pick(SHIRT)}"/><rect x="${x + 16}" y="${y + 290}" width="${r.int(90, 150)}" height="20" rx="6" fill="rgba(0,0,0,.45)"/>`;
  }
  return `<rect width="1300" height="784" fill="#111"/>${tiles}<rect x="0" y="720" width="1300" height="64" fill="#1A1A1A"/><circle cx="600" cy="752" r="18" fill="#3F3F46"/><circle cx="650" cy="752" r="18" fill="#3F3F46"/><rect x="690" y="736" width="70" height="32" rx="8" fill="#E02828"/>`;
}

function docScreen(r: Rng): string {
  let checks = '';
  for (let i = 0; i < 6; i++) {
    const y = 440 + i * 34;
    checks += `<rect x="330" y="${y}" width="16" height="16" rx="3" fill="${i < 2 ? '#2383E2' : '#fff'}" stroke="#9B9A97"/>${lines(r, 360, y + 4, 520, 1, 0, ['#37352F'], 8)}`;
  }
  return `<rect width="1300" height="784" fill="#fff"/><rect width="240" height="784" fill="#F7F6F3"/>${lines(r, 20, 30, 190, 20, 28, ['#91918E', '#B9B8B5'], 8)}<rect x="330" y="70" width="64" height="64" rx="8" fill="${r.pick(['#FDE68A', '#FBCFE8', '#BFDBFE'])}"/><rect x="330" y="160" width="${r.int(360, 540)}" height="26" rx="6" fill="#37352F"/>${lines(r, 330, 220, 760, 7, 26, ['#37352F', '#787774'], 9)}${checks}`;
}

const SCREENS: Record<ScreenKind, (r: Rng) => string> = {
  design: designScreen,
  code: codeScreen,
  terminal: terminalScreen,
  browser: browserScreen,
  chat: chatScreen,
  sheet: sheetScreen,
  call: callScreen,
  doc: docScreen,
};

const WALLPAPERS: ReadonlyArray<readonly [string, string]> = [
  ['#1D2B64', '#F8CDDA'],
  ['#0F2027', '#2C5364'],
  ['#355C7D', '#C06C84'],
  ['#134E5E', '#71B280'],
];

export function screenshotSvg(kind: ScreenKind, variant: number, title: string, blurred: boolean): string {
  const r = rngFor('shot', kind, variant);
  const [w1, w2] = r.pick(WALLPAPERS);
  const inner = SCREENS[kind](r);
  const titleBg = kind === 'code' || kind === 'terminal' || kind === 'call' ? '#2B2B2B' : '#ECECEC';
  const content = `<defs><linearGradient id="wp" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${w1}"/><stop offset="1" stop-color="${w2}"/></linearGradient>${blurred ? '<filter id="bl"><feGaussianBlur stdDeviation="14"/></filter>' : ''}</defs><g${blurred ? ' filter="url(#bl)"' : ''}><rect width="${W}" height="${H}" fill="url(#wp)"/><rect width="${W}" height="26" fill="rgba(0,0,0,.35)"/><rect x="16" y="9" width="12" height="9" rx="2" fill="#fff" opacity=".85"/><rect x="42" y="9" width="60" height="9" rx="3" fill="#fff" opacity=".8"/><rect x="1330" y="9" width="90" height="9" rx="3" fill="#fff" opacity=".8"/>${windowFrame(inner, titleBg, escapeXml(title))}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${content}</svg>`;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const shotCache = new Map<string, string>();

/**
 * A URL for one screenshot variant. blob: URLs keep the JSON small (a day can
 * carry ~80 shots); they are recreated per page load and never persisted.
 */
export function screenshotUrl(kind: ScreenKind, variant: number, title: string, blurred: boolean): string {
  const key = `${kind}:${variant}:${title}:${blurred ? 1 : 0}`;
  const cached = shotCache.get(key);
  if (cached) return cached;
  const svg = screenshotSvg(kind, variant, title, blurred);
  let url: string;
  if (typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  } else {
    url = svgDataUrl(svg);
  }
  shotCache.set(key, url);
  return url;
}
