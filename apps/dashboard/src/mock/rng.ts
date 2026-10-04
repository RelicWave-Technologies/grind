/**
 * Deterministic randomness. The same person on the same date always gets the
 * same day, so reloading, polling and switching roles never reshuffles data.
 */

export function hash(input: string): number {
  // FNV-1a, 32-bit.
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface Rng {
  /** [0, 1) */
  next(): number;
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  range(min: number, max: number): number;
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  weighted<T>(items: ReadonlyArray<readonly [T, number]>): T;
}

export function rngFor(...parts: Array<string | number>): Rng {
  let a = hash(parts.join('|')) || 1;
  const next = () => {
    // mulberry32
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    range: (min, max) => min + next() * (max - min),
    chance: (p) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length)]!,
    weighted: (items) => {
      const total = items.reduce((s, [, w]) => s + w, 0);
      let roll = next() * total;
      for (const [item, w] of items) {
        roll -= w;
        if (roll <= 0) return item;
      }
      return items[items.length - 1]![0];
    },
  };
  return rng;
}

let counter = 0;
/** Unique-enough ids for rows created during the session. */
export function newId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}
