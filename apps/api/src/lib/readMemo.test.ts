import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { memoizedRead, readMemoScope, withReadMemo } from './readMemo';

describe('memoizedRead', () => {
  it('loads every time outside a scope', async () => {
    const load = vi.fn(async () => 1);
    await memoizedRead('k', load);
    await memoizedRead('k', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shares one load per key inside a scope, concurrent callers included', async () => {
    const load = vi.fn(async () => ({ n: 1 }));
    const other = vi.fn(async () => ({ n: 2 }));
    await withReadMemo(async () => {
      const [a, b] = await Promise.all([memoizedRead('k', load), memoizedRead('k', load)]);
      expect(a).toBe(b);
      expect(await memoizedRead('k2', other)).toEqual({ n: 2 });
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(1);
  });

  it('keeps scopes apart', async () => {
    const load = vi.fn(async () => 1);
    await withReadMemo(() => memoizedRead('k', load));
    await withReadMemo(() => memoizedRead('k', load));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('forgets a failed load so the next caller retries', async () => {
    let calls = 0;
    const load = async () => {
      calls += 1;
      if (calls === 1) throw new Error('flaky');
      return 'ok';
    };
    await withReadMemo(async () => {
      await expect(memoizedRead('k', load)).rejects.toThrow('flaky');
      await expect(memoizedRead('k', load)).resolves.toBe('ok');
    });
    expect(calls).toBe(2);
  });
});

describe('readMemoScope', () => {
  function appWith(load: () => Promise<number>) {
    const app = express();
    app.use(readMemoScope);
    const handler: express.RequestHandler = async (_req, res) => {
      const a = await memoizedRead('k', load);
      const b = await memoizedRead('k', load);
      res.json({ a, b });
    };
    app.get('/x', handler);
    app.post('/x', handler);
    return app;
  }

  it('memoises within one GET, never across requests', async () => {
    const load = vi.fn(async () => 7);
    const app = appWith(load);
    await request(app).get('/x').expect(200, { a: 7, b: 7 });
    expect(load).toHaveBeenCalledTimes(1);
    await request(app).get('/x').expect(200);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not memoise writes', async () => {
    const load = vi.fn(async () => 7);
    await request(appWith(load)).post('/x').expect(200);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
