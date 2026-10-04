// An identity tint (DESIGN.md §3 Tints): colour that says "this one, not
// that one" and never a status. Blue is excluded — it means tracked time — and
// so are the good/bad/wait washes, so a badge can never read as an error.
const TINTS = [
  'var(--color-tint-teal)',
  'var(--color-tint-orange)',
  'var(--color-tint-rose)',
  'var(--color-tint-coral)',
  'var(--color-sheet-2)',
] as const;

/** A stable tint for a key (a person's id or name): the same key always gets the same colour. */
export function identityTint(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return TINTS[h % TINTS.length]!;
}
