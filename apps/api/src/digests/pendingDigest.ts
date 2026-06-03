/**
 * Pure pending-approval digest builder (M15).
 *
 * Inputs: every PENDING ManualTimeRequest in the workspace + the current
 * time. Output: one digest per approver listing the items they still
 * owe a decision on, with each item tagged as "stuck" (older than the
 * threshold) or "fresh". The digest sender uses this to format the IM
 * card and to skip approvers whose queue is empty.
 *
 * Pure on purpose — the cron job + the /v1/admin/digests/pending
 * endpoint both feed it the same shape. No DB, no Lark, no clock except
 * what the caller passes in.
 */

export const DEFAULT_STUCK_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48h

export interface PendingRequestInput {
  id: string;
  approverId: string | null;
  requesterId: string;
  requesterName: string;
  requestedStart: number; // epoch ms
  requestedEnd: number;
  createdAtMs: number;
  reason: string;
}

export interface DigestItem {
  requestId: string;
  requesterId: string;
  requesterName: string;
  requestedStart: number;
  requestedEnd: number;
  reason: string;
  ageMs: number;
  isStuck: boolean;
}

export interface ApproverDigest {
  approverId: string;
  stuck: DigestItem[]; // ≥ threshold
  fresh: DigestItem[]; // < threshold
  totalCount: number;
  oldestAgeMs: number; // 0 if no items
}

export interface BuildDigestOpts {
  now: number;
  stuckThresholdMs?: number;
}

/**
 * Group pending requests by approver. Requests with a null approver
 * (orphaned — the approver was deleted, never assigned, etc.) collapse
 * under the synthetic key `'__unassigned__'` so an admin job can pick
 * them up separately.
 *
 * Each approver's digest is returned only if they have at least one
 * item — empty managers are dropped so the sender doesn't spam zero-
 * pending people.
 */
export function buildPendingDigests(
  requests: PendingRequestInput[],
  opts: BuildDigestOpts,
): ApproverDigest[] {
  const threshold = opts.stuckThresholdMs ?? DEFAULT_STUCK_THRESHOLD_MS;
  const byApprover = new Map<string, ApproverDigest>();

  for (const r of requests) {
    const key = r.approverId ?? '__unassigned__';
    const ageMs = Math.max(0, opts.now - r.createdAtMs);
    const item: DigestItem = {
      requestId: r.id,
      requesterId: r.requesterId,
      requesterName: r.requesterName,
      requestedStart: r.requestedStart,
      requestedEnd: r.requestedEnd,
      reason: r.reason,
      ageMs,
      isStuck: ageMs >= threshold,
    };
    let d = byApprover.get(key);
    if (!d) {
      d = {
        approverId: key,
        stuck: [],
        fresh: [],
        totalCount: 0,
        oldestAgeMs: 0,
      };
      byApprover.set(key, d);
    }
    if (item.isStuck) d.stuck.push(item);
    else d.fresh.push(item);
    d.totalCount += 1;
    if (ageMs > d.oldestAgeMs) d.oldestAgeMs = ageMs;
  }

  // Sort stuck and fresh by age desc within each digest.
  for (const d of byApprover.values()) {
    d.stuck.sort((a, b) => b.ageMs - a.ageMs);
    d.fresh.sort((a, b) => b.ageMs - a.ageMs);
  }

  // Approver order: most stuck first; ties broken by oldest age.
  return Array.from(byApprover.values()).sort((a, b) => {
    if (b.stuck.length !== a.stuck.length) return b.stuck.length - a.stuck.length;
    return b.oldestAgeMs - a.oldestAgeMs;
  });
}

/**
 * Plain-text card body for the Lark IM digest. Keep it short and
 * scan-friendly — the manager sees this in a notification preview.
 */
export function formatDigestPlainText(d: ApproverDigest, opts: { dashboardUrl?: string } = {}): string {
  const lines: string[] = [];
  const totalStuck = d.stuck.length;
  if (totalStuck > 0) {
    lines.push(`⏰ ${totalStuck} stuck approval${totalStuck === 1 ? '' : 's'} (waiting ≥48h)`);
  }
  const totalFresh = d.fresh.length;
  if (totalFresh > 0) {
    lines.push(`📥 ${totalFresh} pending approval${totalFresh === 1 ? '' : 's'}`);
  }

  const allItems = [...d.stuck, ...d.fresh].slice(0, 5);
  if (allItems.length > 0) {
    lines.push('');
    for (const it of allItems) {
      const ageH = Math.round(it.ageMs / (60 * 60 * 1000));
      const durH = ((it.requestedEnd - it.requestedStart) / (60 * 60 * 1000)).toFixed(1);
      lines.push(`• ${it.requesterName} — ${durH}h — "${truncate(it.reason, 60)}" (${ageH}h ago)`);
    }
  }
  if (d.totalCount > allItems.length) {
    lines.push(`… and ${d.totalCount - allItems.length} more`);
  }
  if (opts.dashboardUrl) {
    lines.push('');
    lines.push(`Decide here: ${opts.dashboardUrl}`);
  }
  return lines.join('\n');
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}
