import { prisma } from '@grind/db';
import { env } from '../env';
import { logger } from '../logger';
import { getTokenManager } from './index';
import { isLarkConfigured } from './config';
import { LarkReauthRequiredError, LarkTransientError } from './oauthClient';
import type { TokenManager } from './tokenManager';

const CHECK_INTERVAL_MS = 5 * 60_000;
const INITIAL_DELAY_MS = 15_000;
const REFRESH_SCAN_WINDOW_MS = 24 * 60 * 60_000;
const BATCH_SIZE = 500;

export interface LarkTokenRefreshResult {
  checkedRows: number;
  refreshedRows: number;
  skippedRows: number;
  reauthRows: number;
  transientFailures: number;
  errors: number;
  skippedUnconfigured: boolean;
}

type RefreshManager = Pick<TokenManager, 'refreshGrantIfDue'>;

let active = false;

export function startLarkTokenRefreshScheduler(): void {
  if (env.NODE_ENV === 'test' || !isLarkConfigured()) return;
  const tick = async () => {
    try {
      const result = await runLarkTokenRefreshOnce();
      if (result.refreshedRows || result.reauthRows || result.transientFailures || result.errors) {
        logger.info(result, 'lark token refresh scheduler completed');
      }
    } catch (err) {
      logger.warn({ err }, 'lark token refresh scheduler failed');
    }
  };
  const handle = setInterval(tick, CHECK_INTERVAL_MS);
  handle.unref?.();
  setTimeout(tick, INITIAL_DELAY_MS).unref?.();
}

export async function runLarkTokenRefreshOnce(
  now = new Date(),
  manager: RefreshManager | null = getTokenManager(),
): Promise<LarkTokenRefreshResult> {
  const result: LarkTokenRefreshResult = {
    checkedRows: 0,
    refreshedRows: 0,
    skippedRows: 0,
    reauthRows: 0,
    transientFailures: 0,
    errors: 0,
    skippedUnconfigured: false,
  };
  if (!manager) {
    result.skippedUnconfigured = true;
    return result;
  }
  if (active) return result;
  active = true;
  try {
    const rows = await prisma.larkOAuthToken.findMany({
      where: {
        reauthRequired: false,
        refreshExpiresAt: { lte: new Date(now.getTime() + REFRESH_SCAN_WINDOW_MS) },
      },
      select: { userId: true },
      orderBy: { refreshExpiresAt: 'asc' },
      take: BATCH_SIZE,
    });

    for (const row of rows) {
      result.checkedRows += 1;
      try {
        const outcome = await manager.refreshGrantIfDue(row.userId);
        if (outcome === 'refreshed') result.refreshedRows += 1;
        else result.skippedRows += 1;
      } catch (err) {
        if (err instanceof LarkTransientError) {
          result.transientFailures += 1;
        } else if (err instanceof LarkReauthRequiredError) {
          result.reauthRows += 1;
        } else {
          result.errors += 1;
          logger.warn({ err, userId: row.userId }, 'lark proactive token refresh failed');
        }
      }
    }
    return result;
  } finally {
    active = false;
  }
}
