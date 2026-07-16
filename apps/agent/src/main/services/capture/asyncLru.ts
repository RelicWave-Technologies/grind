/** Small promise-aware LRU used for immutable local screenshot thumbnails. */
export class AsyncLru<T> {
  private readonly values = new Map<string, Promise<T | null>>();

  constructor(private readonly maxEntries: number) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error('maxEntries must be a positive integer');
    }
  }

  get(key: string, load: () => Promise<T | null>): Promise<T | null> {
    const existing = this.values.get(key);
    if (existing) {
      this.values.delete(key);
      this.values.set(key, existing);
      return existing;
    }

    const pending = load().then(
      (value) => {
        if (value === null && this.values.get(key) === pending) this.values.delete(key);
        return value;
      },
      (error) => {
        if (this.values.get(key) === pending) this.values.delete(key);
        throw error;
      },
    );
    this.values.set(key, pending);

    while (this.values.size > this.maxEntries) {
      const oldest = this.values.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
    return pending;
  }
}
