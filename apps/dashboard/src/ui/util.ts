/**
 * Internal helpers shared across the kit. Not part of the public API —
 * consumers import components from `./index`, never from here.
 */

/**
 * Join class names, keeping only truthy strings. The kit's only class composer.
 * Accepts `unknown` so guard expressions like `cond && 'x'` (which may evaluate
 * to 0, '', or a ReactNode) are safe — non-string truthy values are dropped.
 */
export function cx(...parts: unknown[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' ');
}

/** The fixed status taxonomy (§2). The same hue means the same thing everywhere. */
export type Status = 'success' | 'warn' | 'danger' | 'info' | 'neutral';

/** Rail accent for table rows / list rows — status hues plus the identity accent. */
export type Rail = 'success' | 'warn' | 'danger' | 'info' | 'accent';

/** Initials from a display name, e.g. "A. Suman" → "AS". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}
