/**
 * Accent palettes under review for the desktop app (2026-09-28). Each one
 * swaps only the brand ramp — the EMIAC neutrals, status colours and type stay
 * — so every option still reads as a sibling of the EMIAC products. The ribbon
 * and heatmap follow automatically, because DESIGN.md defines them as
 * references to the brand ramp.
 *
 * Lab-only: a chosen palette is copied into DESIGN.md, never shipped from here.
 */
export interface Palette {
  label: string;
  note: string;
  /** Overrides for the generated `--color-*` tokens. Empty = DESIGN.md as is. */
  vars: Record<string, string>;
}

function ramp(brand: string, deep: string, hi: string, wash: string, edge: string, heat2: string): Record<string, string> {
  return {
    '--color-brand': brand,
    '--color-brand-deep': deep,
    '--color-brand-hi': hi,
    '--color-brand-wash': wash,
    '--color-brand-edge': edge,
    '--color-heat-2': heat2,
    '--color-series-1': brand,
  };
}

export const PALETTES: Record<string, Palette> = {
  emiac: { label: 'Azure', note: 'DESIGN.md today: #2f6fd0 (chosen 2026-09-28)', vars: {} },
  classic: {
    label: 'EMIAC blue',
    note: 'The EMIAC landing blue, #005cb1',
    vars: ramp('#005cb1', '#004c93', '#3d8ae0', '#eaf2fd', '#b9d3f3', '#7fb0e8'),
  },
  indigo: {
    label: 'Indigo',
    note: 'Blue pulled toward violet; calmer, more "product"',
    vars: ramp('#3f4bb5', '#333d96', '#6e79dc', '#eff0fb', '#cbcff2', '#9aa2e8'),
  },
  petrol: {
    label: 'Petrol',
    note: 'EMIAC blue pulled toward teal; deep and quiet',
    vars: ramp('#0d6485', '#0a4f6a', '#3b91b5', '#e8f3f7', '#b5d6e4', '#7fb6ce'),
  },
  teal: {
    label: 'Teal',
    note: "Timo's old teal, matured; EMIAC already carries a teal",
    vars: ramp('#0f766e', '#0b5d57', '#35a399', '#e7f4f2', '#b3ddd7', '#7cc4bb'),
  },
  iris: {
    label: 'Iris',
    note: "A soft violet, a nod to Timo's first look",
    vars: ramp('#5a4ecb', '#4a3fae', '#8a80e4', '#f1f0fc', '#d4d0f5', '#ada6ee'),
  },
};

export const PALETTE_IDS = Object.keys(PALETTES);

export function paletteCss(id: string): string {
  const palette = PALETTES[id];
  if (!palette || Object.keys(palette.vars).length === 0) return '';
  const body = Object.entries(palette.vars)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');
  // `:root:root` outranks the generated `:root` block whatever order the
  // stylesheets land in, so the override holds through HMR.
  return `:root:root {\n${body}\n}\n`;
}
