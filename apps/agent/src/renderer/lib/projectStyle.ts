import { Monitor, Code2, BookOpen, Dumbbell, Rocket, type LucideIcon } from 'lucide-react';

export interface ProjectStyle {
  color: string; // solid (icon bg / accents)
  tagBg: string; // soft tag background
  tagFg: string; // tag text
  icon: LucideIcon;
}

// NOTE: blue is intentionally excluded — it's reserved for MEETING segments on
// the day-timeline, so a work task can never be mistaken for a meeting.
const PALETTE: ProjectStyle[] = [
  { color: 'var(--c-violet)', tagBg: 'var(--c-violet-bg)', tagFg: 'var(--c-violet)', icon: Monitor },
  { color: 'var(--c-rose)', tagBg: 'var(--c-rose-bg)', tagFg: 'var(--c-rose)', icon: Code2 },
  { color: 'var(--c-green)', tagBg: 'var(--c-green-bg)', tagFg: 'var(--c-green)', icon: BookOpen },
  { color: 'var(--c-orange)', tagBg: 'var(--c-orange-bg)', tagFg: 'var(--c-orange)', icon: Dumbbell },
  { color: 'var(--c-slate)', tagBg: 'var(--c-slate-bg)', tagFg: 'var(--c-slate)', icon: Rocket },
];

/** Stable hash so a project always gets the same color/icon. */
export function projectStyle(id: string): ProjectStyle {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}
