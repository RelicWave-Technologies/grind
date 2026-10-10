import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  bound: true,
}));

vi.mock('electron', () => ({}));
vi.mock('../logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./tokenStore', () => ({ loadTokens: vi.fn(), replaceTokensIfMatch: vi.fn(), clearTokensIfMatch: vi.fn() }));
vi.mock('./timer', () => ({
  bindTimerToStoredSession: vi.fn(async () => {
    mocks.order.push('bind');
    return mocks.bound;
  }),
  drainTimerSyncNow: vi.fn(async () => {
    mocks.order.push('drain');
  }),
  refreshTodayLedger: vi.fn(async () => {
    mocks.order.push('ledger');
  }),
}));
vi.mock('./agentConfig', () => ({
  refreshAgentConfig: vi.fn(async () => {
    mocks.order.push('config');
  }),
}));
vi.mock('./heartbeat', () => ({
  startHeartbeat: vi.fn(() => {
    mocks.order.push('heartbeat');
  }),
}));

const { activateSignedInSession } = await import('./signIn');
const { onAuthChange } = await import('./apiClient');

beforeEach(() => {
  mocks.order.length = 0;
  mocks.bound = true;
});

describe('activateSignedInSession', () => {
  it('tells every auth listener about the sign-in, after the timer is rebound', async () => {
    const off = onAuthChange((status) => mocks.order.push(`listener:${status}`));

    await expect(activateSignedInSession('lark_callback')).resolves.toBe(true);
    off();

    expect(mocks.order[0]).toBe('bind');
    expect(mocks.order.at(-1)).toBe('listener:loggedIn');
    expect(mocks.order).toEqual(expect.arrayContaining(['drain', 'config', 'heartbeat']));
    expect(mocks.order.indexOf('heartbeat')).toBeLessThan(mocks.order.indexOf('listener:loggedIn'));
  });

  it('announces nothing when no session is stored after all', async () => {
    mocks.bound = false;
    const seen: string[] = [];
    const off = onAuthChange((status) => seen.push(status));

    await expect(activateSignedInSession('stored_session')).resolves.toBe(false);
    off();

    expect(seen).toEqual([]);
    expect(mocks.order).toEqual(['bind']);
  });

  it('keeps notifying the remaining listeners when one throws', async () => {
    const seen: string[] = [];
    const offA = onAuthChange(() => {
      throw new Error('boom');
    });
    const offB = onAuthChange((status) => seen.push(status));

    await activateSignedInSession('lark_callback');
    offA();
    offB();

    expect(seen).toEqual(['loggedIn']);
  });
});
