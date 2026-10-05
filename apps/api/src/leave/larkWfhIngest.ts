import { prisma } from '@grind/db';
import { dateKeyInTimeZone } from '@grind/types';
import { logger } from '../logger';
import { requestRuleReconcile } from '../attendance/ruleScheduler';
import { hasLarkCredentials } from '../lark/config';
import { decisionFromLarkStatus, type ExternalDecision } from './approvalGateway';
import { INGEST_LOOKBACK_DAYS, larkGet, listLeaveInstanceCodes } from './larkIngest';
import { fromIsoDate } from './repository';

/**
 * Work-from-home requests are decided in Lark, and Timo mirrors them — the same
 * one-way flow as leave (see `larkIngest.ts`), against a second approval form.
 *
 * The "Work From Home Request" form is simpler than Leave: a free-text reason
 * and a `dateInterval` widget, full days only. Its `end` is the start of the
 * LAST day — inclusive — where the leave widget's `end` is the midnight after
 * it. Reading one with the other's rule shifts every request by a day.
 *
 * Idempotent: `WfhRequest.larkInstanceCode` is unique, so a re-ingest updates.
 */

const DEFAULT_WFH_INGEST_INTERVAL_MS = 10 * 60_000;

export interface LarkWfhInstance {
  instanceCode: string;
  openId: string;
  decision: ExternalDecision;
  /** Inclusive YYYY-MM-DD range. */
  startDate: string;
  endDate: string;
  reason: string;
  /** When it was submitted in Lark, epoch ms. */
  appliedAtMs: number | null;
}

interface WfhIngestResult {
  seen: number;
  linked: number;
  unmatched: number;
}

/** Business date for an instant, in the workspace's IANA timezone. */
function localDate(ms: number, tz: string): string {
  return dateKeyInTimeZone(ms, tz);
}

/**
 * Read one instance body into our shape, or null when it has no readable date
 * range. Pure — split from the fetch so the parsing is testable on its own.
 */
export function parseWfhInstance(
  instanceCode: string,
  data: { status?: string; open_id?: string; user_id?: string; form?: string; start_time?: string },
  tz: string,
): LarkWfhInstance | null {
  let value: Record<string, unknown> | null = null;
  let reason = '';
  try {
    const form = JSON.parse(data.form ?? '[]') as Array<{ type?: string; name?: string; value?: unknown }>;
    const interval = form.find((w) => w.type === 'dateInterval');
    if (interval && interval.value && typeof interval.value === 'object' && !Array.isArray(interval.value)) {
      value = interval.value as Record<string, unknown>;
    }
    const text = form.find((w) => w.type === 'input' || w.type === 'textarea');
    reason = typeof text?.value === 'string' ? text.value.trim() : '';
  } catch {
    value = null;
  }
  if (!value) return null;

  const startMs = Date.parse(String(value.start ?? ''));
  const endMs = Date.parse(String(value.end ?? ''));
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;

  const startDate = localDate(startMs, tz);
  const endDate = localDate(endMs, tz);
  const appliedAtMs = Number.parseInt(String(data.start_time ?? ''), 10);

  return {
    instanceCode,
    openId: String(data.open_id ?? data.user_id ?? ''),
    decision: decisionFromLarkStatus(data.status),
    startDate,
    // A malformed range must not invert; a one-day request has end == start.
    endDate: endDate < startDate ? startDate : endDate,
    reason,
    appliedAtMs: Number.isFinite(appliedAtMs) ? appliedAtMs : null,
  };
}

async function fetchWfhInstanceBody(instanceCode: string): Promise<Record<string, string> | null> {
  const body = await larkGet(`/open-apis/approval/v4/instances/${encodeURIComponent(instanceCode)}?locale=en-US`);
  if (body.code !== 0) {
    logger.warn({ instanceCode, code: body.code, msg: body.msg }, 'lark wfh instance unreadable');
    return null;
  }
  return (body.data ?? {}) as Record<string, string>;
}

function statusFor(decision: ExternalDecision): 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' {
  if (decision === 'APPROVED' || decision === 'REJECTED' || decision === 'CANCELLED') return decision;
  return 'PENDING';
}

async function mirrorWfh(workspaceId: string, instance: LarkWfhInstance): Promise<boolean> {
  const identity = await prisma.larkIdentity.findUnique({
    where: { openId: instance.openId },
    select: { userId: true, user: { select: { workspaceId: true } } },
  });
  if (!identity || identity.user.workspaceId !== workspaceId) return false;

  const fields = {
    startDate: fromIsoDate(instance.startDate),
    endDate: fromIsoDate(instance.endDate),
    reason: instance.reason,
    status: statusFor(instance.decision),
    appliedAt: instance.appliedAtMs === null ? null : new Date(instance.appliedAtMs),
    larkSyncedAt: new Date(),
  };
  await prisma.wfhRequest.upsert({
    where: { larkInstanceCode: instance.instanceCode },
    create: {
      ...fields,
      workspaceId,
      userId: identity.userId,
      larkInstanceCode: instance.instanceCode,
      larkApprovalCode: process.env.LARK_WFH_APPROVAL_CODE ?? null,
    },
    update: fields,
  });
  return true;
}

async function ingestLarkWfhOnce(input?: { lookbackDays?: number; now?: number }): Promise<WfhIngestResult> {
  const empty: WfhIngestResult = { seen: 0, linked: 0, unmatched: 0 };
  const approvalCode = process.env.LARK_WFH_APPROVAL_CODE?.trim();
  if (!approvalCode || !hasLarkCredentials()) return empty;

  const now = input?.now ?? Date.now();
  const fromMs = now - (input?.lookbackDays ?? INGEST_LOOKBACK_DAYS) * 24 * 60 * 60 * 1000;

  const workspaces = await prisma.workspace.findMany({ select: { id: true, timezone: true } });
  if (workspaces.length === 0) return empty;

  let codes: string[];
  try {
    codes = await listLeaveInstanceCodes({ approvalCode, fromMs, toMs: now });
  } catch (err) {
    logger.warn({ err: String(err) }, 'lark wfh ingest could not list instances');
    return empty;
  }

  const result: WfhIngestResult = { seen: codes.length, linked: 0, unmatched: 0 };
  const touched = new Set<string>();
  for (const code of codes) {
    let data: Record<string, string> | null;
    try {
      data = await fetchWfhInstanceBody(code);
    } catch (err) {
      logger.warn({ err: String(err), code }, 'lark wfh instance fetch failed');
      continue;
    }
    if (!data) continue;
    for (const ws of workspaces) {
      // Each workspace reads the dates on its own calendar.
      const instance = parseWfhInstance(code, data, ws.timezone);
      if (!instance) {
        logger.warn({ instanceCode: code }, 'lark wfh instance has no readable date range');
        break;
      }
      if (!instance.openId) break;
      if (await mirrorWfh(ws.id, instance)) {
        result.linked += 1;
        touched.add(ws.id);
        break;
      }
    }
  }
  // Approved WFH decides whether a remote day is charged.
  for (const workspaceId of touched) requestRuleReconcile(workspaceId);
  result.unmatched = result.seen - result.linked;
  logger.info(result, 'lark wfh ingested');
  return result;
}

let timer: NodeJS.Timeout | null = null;

export function startLarkWfhIngest(intervalMs = DEFAULT_WFH_INGEST_INTERVAL_MS): void {
  if (timer || process.env.NODE_ENV === 'test') return;
  if (!process.env.LARK_WFH_APPROVAL_CODE?.trim() || !hasLarkCredentials()) {
    logger.info('lark wfh ingest not started — no approval code configured');
    return;
  }
  const run = () => {
    ingestLarkWfhOnce().catch((err) => {
      logger.error({ err: String(err) }, 'lark wfh ingest crashed');
    });
  };
  // Once at boot: the rules read WFH, and waiting ten minutes after a deploy
  // would let a report judge September with no approvals loaded yet.
  setTimeout(run, 30_000).unref?.();
  timer = setInterval(run, intervalMs);
  timer.unref?.();
  logger.info({ intervalMs }, 'lark wfh ingest started');
}
