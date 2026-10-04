import { describe, expect, it, vi } from 'vitest';
import type { TodayLedgerResponse } from '@grind/types';
import { TodayLedgerHydrator } from './todayLedgerHydrator';

const tokens = {
  accessToken: 'access',
  refreshToken: 'refresh',
  userId: 'user-1',
  workspaceId: 'workspace-1',
};

function response(): TodayLedgerResponse {
  return {
    complete: true,
    serverTime: new Date(1_000).toISOString(),
    workspaceTimezone: 'Asia/Kolkata',
    entries: [],
    effectiveEntries: [],
  };
}

function harness(overrides: Partial<ConstructorParameters<typeof TodayLedgerHydrator>[0]> = {}) {
  const replaceSnapshot = vi.fn();
  const onUpdated = vi.fn();
  const timer = {
    currentOwner: () => ({ userId: tokens.userId, workspaceId: tokens.workspaceId }),
    flushUnsynced: vi.fn().mockResolvedValue(undefined),
    claimServerMatchedEntries: vi.fn().mockReturnValue(0),
    todayLedgerDiagnostics: vi.fn().mockReturnValue({ localMs: 1_000, mergedMs: 1_500, conflicts: 1 }),
  };
  const deps = {
    timer: timer as never,
    cache: { replaceSnapshot } as never,
    getMode: () => 'VISIBLE' as const,
    loadTokens: vi.fn().mockResolvedValue(tokens),
    getWindow: () => ({ start: 0, end: 86_400_000 }),
    fetchSnapshot: vi.fn().mockResolvedValue(response()),
    onUpdated,
    log: { debug: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
  return { hydrator: new TodayLedgerHydrator(deps), deps, replaceSnapshot, onUpdated, timer };
}

describe('TodayLedgerHydrator', () => {
  it('replaces cache only after a complete validated response', async () => {
    const { hydrator, replaceSnapshot, onUpdated } = harness();
    await hydrator.refresh('manual');
    expect(replaceSnapshot).toHaveBeenCalledOnce();
    expect(onUpdated).toHaveBeenCalledOnce();
  });

  it('does not clear the old cache when the response is malformed', async () => {
    const { hydrator, replaceSnapshot, deps } = harness({
      fetchSnapshot: vi.fn().mockResolvedValue({ complete: false, entries: [] }),
    });
    await hydrator.refresh('manual');
    expect(replaceSnapshot).not.toHaveBeenCalled();
    expect(deps.log.warn).toHaveBeenCalledOnce();
  });

  it('discards a response if the logged-in owner changes while it is in flight', async () => {
    const loadTokens = vi.fn()
      .mockResolvedValueOnce(tokens)
      .mockResolvedValueOnce({ ...tokens, userId: 'user-2' });
    const { hydrator, replaceSnapshot } = harness({ loadTokens });
    await hydrator.refresh('manual');
    expect(replaceSnapshot).not.toHaveBeenCalled();
  });

  it('runs a queued auth refresh after an older session request completes', async () => {
    let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    const fetchSnapshot = vi.fn()
      .mockImplementationOnce(async () => {
        await first;
        return response();
      })
      .mockResolvedValueOnce(response());
    const { hydrator } = harness({ fetchSnapshot });
    const initial = hydrator.refresh('interval');
    const queued = hydrator.refresh('auth');
    release();
    await Promise.all([initial, queued]);
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it('does no work while hydration is off', async () => {
    const { hydrator, deps, replaceSnapshot, onUpdated, timer } = harness({
      getMode: () => 'OFF',
    });
    await hydrator.refresh('manual');
    expect(deps.loadTokens).not.toHaveBeenCalled();
    expect(deps.fetchSnapshot).not.toHaveBeenCalled();
    expect(timer.flushUnsynced).not.toHaveBeenCalled();
    expect(replaceSnapshot).not.toHaveBeenCalled();
    expect(onUpdated).not.toHaveBeenCalled();
  });

  it('caches and compares in shadow mode without claiming rows or updating the UI', async () => {
    const { hydrator, deps, replaceSnapshot, onUpdated, timer } = harness({
      getMode: () => 'SHADOW',
    });
    await hydrator.refresh('manual');
    expect(replaceSnapshot).toHaveBeenCalledOnce();
    expect(timer.todayLedgerDiagnostics).toHaveBeenCalledOnce();
    expect(timer.claimServerMatchedEntries).not.toHaveBeenCalled();
    expect(onUpdated).not.toHaveBeenCalled();
    expect(deps.log.debug).toHaveBeenCalledWith(
      'today ledger shadow comparison complete',
      expect.objectContaining({ localMs: 1_000, mergedMs: 1_500, deltaMs: 500, conflicts: 1 }),
    );
  });

  it('discards an in-flight response when hydration is disabled', async () => {
    let mode: 'VISIBLE' | 'OFF' = 'VISIBLE';
    const fetchSnapshot = vi.fn().mockImplementation(async () => {
      mode = 'OFF';
      return response();
    });
    const { hydrator, replaceSnapshot, onUpdated } = harness({
      getMode: () => mode,
      fetchSnapshot,
    });
    await hydrator.refresh('manual');
    expect(replaceSnapshot).not.toHaveBeenCalled();
    expect(onUpdated).not.toHaveBeenCalled();
  });
});
