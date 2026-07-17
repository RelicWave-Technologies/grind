import { TodayLedgerResponse, type TodayLedgerMode } from '@grind/types';
import type { TimerService } from './timerService';
import type { SqliteTodayLedgerStore } from './todayLedgerStore';
import type { StoredTokens } from '../tokenStore';

export type TodayLedgerRefreshReason = 'boot' | 'interval' | 'mutation' | 'wake' | 'manual' | 'auth' | 'config';

interface HydratorDeps {
  timer: TimerService;
  cache: SqliteTodayLedgerStore;
  getMode: () => TodayLedgerMode;
  loadTokens: () => Promise<StoredTokens | null>;
  getWindow: () => { start: number; end: number } | null;
  fetchSnapshot: (path: string) => Promise<unknown>;
  onUpdated: () => void;
  log: {
    debug(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}

export class TodayLedgerHydrator {
  private inFlight: Promise<void> | null = null;
  private queuedReason: TodayLedgerRefreshReason | null = null;
  private interval: NodeJS.Timeout | null = null;

  constructor(private readonly deps: HydratorDeps) {}

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => void this.refresh('interval'), 60_000);
  }

  stop(): void {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
  }

  refresh(reason: TodayLedgerRefreshReason): Promise<void> {
    this.queuedReason = reason;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.drainQueue().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async drainQueue(): Promise<void> {
    while (this.queuedReason) {
      const reason = this.queuedReason;
      this.queuedReason = null;
      try {
        await this.run(reason);
      } catch (err) {
        // A snapshot is advisory. Keep the last complete cache and retry on the
        // next trigger without leaking an unhandled rejection into Electron.
        this.deps.log.warn('today ledger refresh failed; keeping previous cache', {
          reason,
          err: String(err),
        });
      }
    }
  }

  private async run(reason: TodayLedgerRefreshReason): Promise<void> {
    if (this.deps.getMode() === 'OFF') return;
    const session = await this.deps.loadTokens();
    const window = this.deps.getWindow();
    if (!session || !window) return;
    const owner = { userId: session.userId, workspaceId: session.workspaceId };
    if (
      this.deps.timer.currentOwner()?.userId !== owner.userId
      || this.deps.timer.currentOwner()?.workspaceId !== owner.workspaceId
    ) return;

    try {
      await this.deps.timer.flushUnsynced();
    } catch (err) {
      this.deps.log.debug('today ledger continuing with pending local rows', { reason, err: String(err) });
    }

    const query = new URLSearchParams({
      from: new Date(window.start).toISOString(),
      to: new Date(window.end).toISOString(),
    });
    const raw = await this.deps.fetchSnapshot(`/v1/agent/today-ledger?${query.toString()}`);
    const response = TodayLedgerResponse.parse(raw);

    const current = await this.deps.loadTokens();
    if (!current || current.userId !== owner.userId || current.workspaceId !== owner.workspaceId) {
      this.deps.log.debug('discarded today ledger from an older login session', { reason });
      return;
    }
    const mode = this.deps.getMode();
    if (mode === 'OFF') {
      this.deps.log.debug('discarded today ledger because hydration was disabled', { reason });
      return;
    }
    const approvedManualEntries = response.approvedManualEntries ?? [];
    if (
      response.entries.some((entry) => entry.userId !== owner.userId || entry.source !== 'AUTO')
      || approvedManualEntries.some((entry) => (
        entry.userId !== owner.userId
        || entry.source !== 'MANUAL'
        || entry.endedAt === null
        || entry.segments.some((segment) => segment.endedAt === null)
      ))
    ) {
      throw new Error('today_ledger_owner_mismatch');
    }
    this.deps.cache.replaceSnapshot(owner, window, response);
    if (mode === 'SHADOW') {
      const diagnostics = this.deps.timer.todayLedgerDiagnostics();
      this.deps.log.debug('today ledger shadow comparison complete', {
        reason,
        entries: response.entries.length,
        localMs: diagnostics?.localMs ?? null,
        mergedMs: diagnostics?.mergedMs ?? null,
        deltaMs: diagnostics ? diagnostics.mergedMs - diagnostics.localMs : null,
        conflicts: diagnostics?.conflicts ?? null,
      });
      return;
    }
    this.deps.timer.claimServerMatchedEntries(
      response.entries.map((entry) => ({ id: entry.id, clientUuid: entry.clientUuid })),
    );
    this.deps.onUpdated();
    this.deps.log.debug('today ledger snapshot refreshed', {
      reason,
      autoEntries: response.entries.length,
      approvedManualEntries: approvedManualEntries.length,
    });
  }
}
