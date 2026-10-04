/**
 * Seeded deterministic PRNG (mulberry32). No dependency, identical on every
 * platform: it uses only 32-bit integer maths, so a fixture regenerates byte
 * for byte from its recorded seed.
 */
export class Rng {
  private state: number;

  constructor(readonly seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [lo, hi] (range up to 2^32). */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick: empty list');
    return items[this.int(0, items.length - 1)]!;
  }

  /** `pick` with weights. */
  weighted<T>(items: ReadonlyArray<readonly [T, number]>): T {
    const total = items.reduce((sum, [, w]) => sum + w, 0);
    let roll = this.next() * total;
    for (const [item, weight] of items) {
      roll -= weight;
      if (roll < 0) return item;
    }
    return items[items.length - 1]![0];
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }

  /** A uniformly random integer with 53 bits of magnitude, either sign. */
  wideInt(): number {
    const high = Math.floor(this.next() * 2 ** 21);
    const low = Math.floor(this.next() * 2 ** 32);
    const magnitude = high * 2 ** 32 + low;
    return this.chance(0.5) ? magnitude : -magnitude;
  }
}

/** FNV-1a, to derive a stable per-function seed from its name. */
export function seedFor(name: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
