import { Monitor, Code2, BookOpen, Dumbbell, Rocket, type LucideIcon } from 'lucide-react';

export interface ProjectStyle {
  color: string; // solid (icon bg / accents)
  tagBg: string; // soft tag background
  tagFg: string; // tag text
  icon: LucideIcon;
}

// A task's identity tile takes one of the EMIAC tints (DESIGN.md §3): colour
// that says "this one, not that one" and never a status. Blue is excluded —
// it means tracked time — and so are the good/bad/wait washes, so a task tile
// can never be read as an error or a warning.
const PALETTE: ProjectStyle[] = [
  { color: 'var(--color-tint-teal)', tagBg: 'var(--color-tint-teal)', tagFg: 'var(--color-ink-2)', icon: Monitor },
  { color: 'var(--color-tint-orange)', tagBg: 'var(--color-tint-orange)', tagFg: 'var(--color-ink-2)', icon: Code2 },
  { color: 'var(--color-tint-rose)', tagBg: 'var(--color-tint-rose)', tagFg: 'var(--color-ink-2)', icon: BookOpen },
  { color: 'var(--color-sheet-2)', tagBg: 'var(--color-sheet-2)', tagFg: 'var(--color-ink-2)', icon: Dumbbell },
  { color: 'var(--color-tint-coral)', tagBg: 'var(--color-tint-coral)', tagFg: 'var(--color-ink-2)', icon: Rocket },
];

/** Stable hash so a project always gets the same color/icon. */
export function projectStyle(id: string): ProjectStyle {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}
