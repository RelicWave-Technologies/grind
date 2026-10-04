import { describe, expect, it, vi } from 'vitest';
import { AsyncLru } from './asyncLru';

describe('AsyncLru', () => {
  it('deduplicates concurrent loads for the same immutable key', async () => {
    const load = vi.fn().mockResolvedValue('thumb');
    const cache = new AsyncLru<string>(2);

    await expect(Promise.all([cache.get('a', load), cache.get('a', load)])).resolves.toEqual(['thumb', 'thumb']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('evicts the least recently used value at the configured bound', async () => {
    const cache = new AsyncLru<string>(2);
    const load = (value: string) => vi.fn().mockResolvedValue(value);
    const loadA = load('a');
    const loadB = load('b');
    const reloadA = load('a2');

    await cache.get('a', loadA);
    await cache.get('b', loadB);
    await cache.get('c', load('c'));
    await expect(cache.get('a', reloadA)).resolves.toBe('a2');
    expect(reloadA).toHaveBeenCalledTimes(1);
  });

  it('does not retain failed or missing values', async () => {
    const cache = new AsyncLru<string>(2);
    const missing = vi.fn().mockResolvedValue(null);
    const failed = vi.fn().mockRejectedValue(new Error('disk error'));

    await expect(cache.get('missing', missing)).resolves.toBeNull();
    await expect(cache.get('missing', missing)).resolves.toBeNull();
    await expect(cache.get('failed', failed)).rejects.toThrow('disk error');
    await expect(cache.get('failed', failed)).rejects.toThrow('disk error');
    expect(missing).toHaveBeenCalledTimes(2);
    expect(failed).toHaveBeenCalledTimes(2);
  });
});
