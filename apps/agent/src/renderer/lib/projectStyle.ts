import { Monitor, Code2, BookOpen, Dumbbell, Rocket, type LucideIcon } from 'lucide-react';

export interface ProjectStyle {
  color: string; // solid (icon bg / accents)
  tagBg: string; // soft tag background
  tagFg: string; // tag text
  icon: LucideIcon;
}

// NOTE: blue is intentionally excluded — it's reserved for MEETING segments on
// the day-timeline, so a work task can never be mistaken for a meeting.
// Figma block pastels for the icon chip (bright, like the dashboard stat tiles);
// the matching dark ink is used for the icon glyph + the soft tag text.
const PALETTE: ProjectStyle[] = [
  { color: 'var(--c-violet-bg)', tagBg: 'var(--c-violet-bg)', tagFg: 'var(--c-violet)', icon: Monitor },  // lilac
  { color: 'var(--c-orange-bg)', tagBg: 'var(--c-orange-bg)', tagFg: 'var(--c-orange)', icon: Code2 },     // coral
  { color: 'var(--c-green-bg)', tagBg: 'var(--c-green-bg)', tagFg: 'var(--c-green)', icon: BookOpen },      // mint
  { color: 'var(--c-amber-bg)', tagBg: 'var(--c-amber-bg)', tagFg: 'var(--c-amber)', icon: Dumbbell },     // cream
  { color: 'var(--c-rose-bg)', tagBg: 'var(--c-rose-bg)', tagFg: 'var(--c-rose)', icon: Rocket },          // pink
];

/** Stable hash so a project always gets the same color/icon. */
export function projectStyle(id: string): ProjectStyle {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}
