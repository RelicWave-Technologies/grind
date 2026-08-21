import { prisma } from '@grind/db';
import { roundToHalfDay, type LeavePortion } from '@grind/types';
import { logger } from '../logger';
import { getLarkConfig, hasLarkCredentials } from '../lark/config';
import { getTenantAccessToken } from '../lark/tenantToken';
import { consumptionSourceKey, reversalSourceKey } from './ledger';
import { fromIsoDate, loadWorkingCalendar, toIsoDate } from './repository';
import { leaveDateRange } from './workingCalendar';
import { decisionFromLarkStatus, type ExternalDecision } from './approvalGateway';

/**
 * Leave is decided in Lark, and Timo mirrors it.
 *
 * Timo cannot raise a Lark leave request: the leave-type control needs a
 * leave-type id that this tenant exposes nowhere — the approval definition
 * returns an empty option list, instances only ever echo the display name, and
 * the list-leave-types API belongs to CoreHR, which this tenant does not have.
 * Reading, by contrast, works completely.
 *
 * So the flow is one-directional. People apply in Lark exactly as they already
 * do; Timo ingests what Lark decided and owns the part Lark has no answer for —
 * the balance. Lark knows what was approved. It does not know what anybody has
 * left, because that lives in CoreHR too.
 *
 * Everything here is idempotent. `LeaveRequest.larkInstanceCode` is unique and
 * the ledger's `sourceKey` is unique, so a re-ingest of the same instance
 * updates rather than duplicates, and a re-charge collides rather than
 * double-counting.
 */

/** How far back a routine sweep looks. Lark requires a bounded window. */
export const INGEST_LOOKBACK_DAYS = 90;
export const DEFAULT_INGEST_INTERVAL_MS = 10 * 60_000;

/** Instances fetched per page. Lark caps this at 100. */
const PAGE_SIZE = 50;

export interface LarkLeaveInstance {
  instanceCode: string;
  openId: string;
  decision: ExternalDecision;
  startDate: string;
  endDate: string;
  portion: LeavePortion;
  /** What Lark says the request is worth, in days. */
  larkDays: number;
  leaveTypeName: string;
  reason: string;
}

export interface LeaveIngestResult {
  seen: number;
  linked: number;
  unmatched: number;
  charged: number;
}

// ---------------------------------------------------------------------------
// Reading Lark
// ---------------------------------------------------------------------------

async function larkGet(path: string): Promise<Record<string, unknown>> {
  const { oauthHost } = getLarkConfig();
  const token = await getTenantAccessToken();
  const res = await fetch(`${oauthHost}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

/** Every instance code for the leave approval inside a window. */
export async function listLeaveInstanceCodes(input: {
  approvalCode: string;
  fromMs: number;
  toMs: number;
  maxPages?: number;
}): Promise<string[]> {
  const codes: string[] = [];
  let pageToken: string | null = null;
  const maxPages = input.maxPages ?? 20;

  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams({
      approval_code: input.approvalCode,
      start_time: String(input.fromMs),
      end_time: String(input.toMs),
      page_size: String(PAGE_SIZE),
    });
    if (pageToken) qs.set('page_token', pageToken);

    const body = await larkGet(`/open-apis/approval/v4/instances?${qs.toString()}`);
    if (body.code !== 0) {
      throw new Error(`lark instance list failed: ${String(body.msg ?? body.code)}`);
    }
    const data = (body.data ?? {}) as {
      instance_code_list?: string[];
      has_more?: boolean;
      page_token?: string;
    };
    codes.push(...(data.instance_code_list ?? []));
    if (!data.has_more || !data.page_token) break;
    pageToken = data.page_token;
  }
  return codes;
}

/**
 * Read one instance into our own shape.
 *
 * The instance form is the compact object Lark returns on read — the very shape
 * that could not be posted back on create. For reading it is everything we
 * need: the range, the duration on the 0.5 grid, and which half of the day,
 * carried as the AM/PM of the start time rather than as a field.
 */
export async function fetchLeaveInstance(
  instanceCode: string,
  tzOffsetMin: number,
): Promise<LarkLeaveInstance | null> {
  const body = await larkGet(
    `/open-apis/approval/v4/instances/${encodeURIComponent(instanceCode)}?locale=en-US`,
  );
  if (body.code !== 0) {
    logger.warn({ instanceCode, code: body.code, msg: body.msg }, 'lark leave instance unreadable');
    return null;
  }
  const data = (body.data ?? {}) as { status?: string; open_id?: string; user_id?: string; form?: string };

  let value: Record<string, unknown> | null = null;
  try {
    const form = JSON.parse(data.form ?? '[]') as Array<{ type?: string; value?: unknown }>;
    const group = form.find((w) => w.type === 'leaveGroupV2');
    if (group && group.value && typeof group.value === 'object' && !Array.isArray(group.value)) {
      value = group.value as Record<string, unknown>;
    }
  } catch {
    value = null;
  }
  if (!value) {
    logger.warn({ instanceCode }, 'lark leave instance has no readable leave widget');
    return null;
  }

  const startIso = String(value.start ?? '');
  const endIso = String(value.end ?? '');
  if (!startIso || !endIso) return null;

  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;

  const larkDays = Number.parseFloat(String(value.interval ?? '0')) || 0;
  return {
    instanceCode,
    openId: String(data.open_id ?? data.user_id ?? ''),
    decision: decisionFromLarkStatus(data.status),
    startDate: localDate(startMs, tzOffsetMin),
    endDate: endDateOf(endMs, tzOffsetMin),
    portion: portionFor(larkDays, startMs, tzOffsetMin),
    larkDays,
    leaveTypeName: String(value.name ?? 'Leave'),
    reason: String(value.reason ?? '').trim(),
  };
}

/** Business date for an instant, in the workspace's offset. */
function localDate(ms: number, tzOffsetMin: number): string {
  return new Date(ms - tzOffsetMin * 60_000).toISOString().slice(0, 10);
}

/**
 * The last date a leave actually covers.
 *
 * Lark's `end` is EXCLUSIVE: a one-day leave runs 00:00 to 00:00 the following
 * day, a two-day leave spans two midnights, and a nine-day leave ends on the
 * tenth midnight. Taking that instant's date directly counts one day too many —
 * a single day's leave would be charged as two, every time.
 *
 * Stepping back a millisecond lands on the real last day and works for
 * part-days too, where the end is a wall-clock time rather than a midnight
 * (an afternoon half-day ends at the following midnight, a morning one at noon).
 */
function endDateOf(endMs: number, tzOffsetMin: number): string {
  return localDate(endMs - 1, tzOffsetMin);
}

export { endDateOf as __endDateOfForTests };

/**
 * Which half of the day a part-day absence covers.
 *
 * Lark has no portion field — it encodes the half in the times, which is why a
 * "Half Day PM" arrives as a start time in the afternoon. Anything worth a full
 * day or more is FULL.
 */
export function portionFor(larkDays: number, startMs: number, tzOffsetMin: number): LeavePortion {
  if (larkDays >= 1) return 'FULL';
  const localHour = new Date(startMs - tzOffsetMin * 60_000).getUTCHours();
  return localHour < 12 ? 'FIRST_HALF' : 'SECOND_HALF';
}

// ---------------------------------------------------------------------------
// Writing Timo
// ---------------------------------------------------------------------------

/**
 * Mirror one Lark instance into Timo, pricing it with OUR Working Calendar.
 *
 * Deliberately not Lark's `interval`: Lark counts calendar days and knows
 * nothing about this workspace's shifts or company holidays. Somebody who books
 * Mon-Fri across a holiday is charged four days here and five there, and the
 * four is the one their balance should reflect.
 */
async function mirrorInstance(input: {
  workspaceId: string;
  tz: string;
  instance: LarkLeaveInstance;
}): Promise<'linked' | 'unmatched' | 'charged'> {
  const { instance } = input;

  const identity = await prisma.larkIdentity.findUnique({
    where: { openId: instance.openId },
    select: {
      userId: true,
      user: { select: { workspaceId: true, joinedOn: true, createdAt: true } },
    },
  });
  if (!identity || identity.user.workspaceId !== input.workspaceId) return 'unmatched';

  /**
   * Never charge leave from before the person was accruing.
   *
   * Accrual starts at `joinedOn`, falling back to the Timo account date. Lark,
   * meanwhile, remembers far more history than Timo has existed for — so a
   * straight import bills months of real leave against a balance that only
   * began accruing weeks ago, and the whole company lands deep in the negative
   * through no fault of their own.
   *
   * The two sides of the ledger have to cover the same window. Leave that
   * predates the accrual start is still mirrored, so the calendar and reports
   * show it, but it is not charged.
   */
  const accrualStart = toIsoDate(identity.user.joinedOn ?? identity.user.createdAt);
  const chargeable = instance.startDate >= accrualStart;

  const kind = 'PAID' as const;
  const calendar = await loadWorkingCalendar({
    workspaceId: input.workspaceId,
    tz: input.tz,
    userIds: [identity.userId],
    from: instance.startDate,
    to: instance.endDate,
  });
  const priced = calendar.quote({
    userId: identity.userId,
    dates: leaveDateRange(instance.startDate, instance.endDate, 120),
    portion: instance.portion,
    kind,
  });
  const quote = chargeable ? priced : { ...priced, chargedDays: 0 };

  const status =
    instance.decision === 'APPROVED'
      ? 'APPROVED'
      : instance.decision === 'REJECTED' || instance.decision === 'CANCELLED'
        ? 'REJECTED'
        : 'PENDING';

  const request = await prisma.leaveRequest.upsert({
    where: { larkInstanceCode: instance.instanceCode },
    create: {
      clientUuid: `lark:${instance.instanceCode}`,
      workspaceId: input.workspaceId,
      userId: identity.userId,
      kind,
      startDate: fromIsoDate(instance.startDate),
      endDate: fromIsoDate(instance.endDate),
      portion: instance.portion,
      chargedDays: quote.chargedDays,
      reason: instance.reason || instance.leaveTypeName,
      status,
      decisionSource: 'LARK_APPROVAL',
      decidedAt: status === 'PENDING' ? null : new Date(),
      larkInstanceCode: instance.instanceCode,
      larkApprovalCode: process.env.LARK_LEAVE_APPROVAL_CODE ?? null,
      larkSyncedAt: new Date(),
    },
    update: {
      status,
      chargedDays: quote.chargedDays,
      portion: instance.portion,
      startDate: fromIsoDate(instance.startDate),
      endDate: fromIsoDate(instance.endDate),
      decisionSource: 'LARK_APPROVAL',
      larkSyncedAt: new Date(),
    },
    select: { id: true, userId: true, status: true },
  });

  if (status === 'APPROVED' && quote.chargedDays > 0) {
    const created = await prisma.leaveLedgerEntry.createMany({
      data: [
        {
          workspaceId: input.workspaceId,
          userId: identity.userId,
          kind: 'CONSUMPTION',
          days: -quote.chargedDays,
          effectiveOn: fromIsoDate(instance.startDate),
          sourceKey: consumptionSourceKey(request.id),
          reason: `${instance.leaveTypeName} (Lark)`,
          requestId: request.id,
        },
      ],
      skipDuplicates: true,
    });
    if (created.count > 0) return 'charged';
  }

  // Something approved and then withdrawn in Lark must give the days back.
  if (status === 'REJECTED') {
    const charge = await prisma.leaveLedgerEntry.findUnique({
      where: { sourceKey: consumptionSourceKey(request.id) },
      select: { days: true },
    });
    if (charge) {
      await prisma.leaveLedgerEntry.createMany({
        data: [
          {
            workspaceId: input.workspaceId,
            userId: identity.userId,
            kind: 'ADJUSTMENT',
            days: roundToHalfDay(-charge.days),
            effectiveOn: fromIsoDate(instance.startDate),
            sourceKey: reversalSourceKey(request.id),
            reason: 'Withdrawn or rejected in Lark',
            requestId: request.id,
          },
        ],
        skipDuplicates: true,
      });
    }
  }

  return 'linked';
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

export async function ingestLarkLeaveOnce(input?: {
  lookbackDays?: number;
  now?: number;
}): Promise<LeaveIngestResult> {
  const empty: LeaveIngestResult = { seen: 0, linked: 0, unmatched: 0, charged: 0 };
  const approvalCode = process.env.LARK_LEAVE_APPROVAL_CODE?.trim();
  if (!approvalCode || !hasLarkCredentials()) return empty;

  const tzOffsetMin = Number.parseInt(process.env.LARK_LEAVE_TZ_OFFSET_MIN ?? '-330', 10);
  const now = input?.now ?? Date.now();
  const fromMs = now - (input?.lookbackDays ?? INGEST_LOOKBACK_DAYS) * 24 * 60 * 60 * 1000;

  const workspaces = await prisma.workspace.findMany({ select: { id: true, timezone: true } });
  if (workspaces.length === 0) return empty;

  let codes: string[];
  try {
    codes = await listLeaveInstanceCodes({ approvalCode, fromMs, toMs: now });
  } catch (err) {
    logger.warn({ err: String(err) }, 'lark leave ingest could not list instances');
    return empty;
  }

  const result: LeaveIngestResult = { seen: codes.length, linked: 0, unmatched: 0, charged: 0 };

  for (const code of codes) {
    let instance: LarkLeaveInstance | null;
    try {
      instance = await fetchLeaveInstance(code, tzOffsetMin);
    } catch (err) {
      logger.warn({ err: String(err), code }, 'lark leave instance fetch failed');
      continue;
    }
    if (!instance || !instance.openId) continue;

    // One tenant, but be explicit rather than assuming a single workspace.
    for (const ws of workspaces) {
      const outcome = await mirrorInstance({
        workspaceId: ws.id,
        tz: ws.timezone,
        instance,
      });
      if (outcome === 'unmatched') continue;
      result.linked += 1;
      if (outcome === 'charged') result.charged += 1;
      break;
    }
  }

  result.unmatched = result.seen - result.linked;
  logger.info(result, 'lark leave ingested');
  return result;
}

let timer: NodeJS.Timeout | null = null;

export function startLarkLeaveIngest(intervalMs = DEFAULT_INGEST_INTERVAL_MS): void {
  if (timer || process.env.NODE_ENV === 'test') return;
  if (!process.env.LARK_LEAVE_APPROVAL_CODE?.trim() || !hasLarkCredentials()) {
    logger.info('lark leave ingest not started — no approval code configured');
    return;
  }
  timer = setInterval(() => {
    ingestLarkLeaveOnce().catch((err) => {
      logger.error({ err: String(err) }, 'lark leave ingest crashed');
    });
  }, intervalMs);
  timer.unref?.();
  logger.info({ intervalMs }, 'lark leave ingest started');
}

export function stopLarkLeaveIngest(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
