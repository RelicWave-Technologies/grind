/**
 * Pure heuristic triage for manual-time approval requests (M17).
 *
 * Goal: cut a manager's decision time from "read every line" to "scan the
 * green / amber / red badge, drill in only when warranted." This is NOT
 * an auto-approver — every request still requires a human click. The
 * triage is a recommendation, with surfaced reasons so the manager can
 * sanity-check it.
 *
 * Deterministic. No LLM. The signals are derived from data the API
 * already has: the requester's recent AUTO time, their typical-day
 * average, the reason text, prior rejections. Easy to extend (e.g. add
 * shift-window check, attendee-consistency check) by appending to
 * `signals[]`.
 */

export type TriageVerdict = 'approve' | 'review' | 'reject';

export interface TriageRequestInput {
  /** The manual-time request to triage. */
  requestedStartMs: number;
  requestedEndMs: number;
  reason: string;

  /** Context the engine reasons over (already filtered to the requester). */
  context: TriageContext;
}

export interface TriageContext {
  /** Total AUTO tracked ms on the SAME day as the request (any kind). */
  autoTrackedSameDayMs: number;
  /** Closest AUTO segment edge to the requested window, in either
   *  direction. Lower = the gap looks plausible. */
  closestAutoEdgeMs: number;
  /** Trailing-30-day daily-average TOTAL tracked ms for the requester. */
  avgDailyTotalMs: number;
  /** Count of REJECTED requests from this user in the last 30 days. */
  rejectedLast30Days: number;
  /** Count of APPROVED requests from this user in the last 30 days. */
  approvedLast30Days: number;
  /** Age of the request itself (ms). Stuck → "needs review" nudge. */
  requestAgeMs: number;
}

export interface TriageSignal {
  /** Internal id — useful in tests + dashboard tooltips. */
  id:
    | 'duration_in_range'
    | 'duration_out_of_range'
    | 'adjacent_to_auto'
    | 'isolated_from_auto'
    | 'reason_short'
    | 'reason_generic'
    | 'reason_substantive'
    | 'frequent_rejections'
    | 'clean_history'
    | 'request_stuck';
  text: string;
  /** Positive → tilts toward approve; negative → tilts toward reject. */
  weight: number;
}

export interface TriageResult {
  verdict: TriageVerdict;
  /** 0–1, how confident the verdict is. <0.4 = neutral, surface as review. */
  confidence: number;
  signals: TriageSignal[];
  /** Compact one-line headline for the dashboard badge. */
  headline: string;
}

const MS_PER_HOUR = 60 * 60 * 1000;
const GENERIC_REASONS = [
  'forgot',
  'forgot to start',
  'forgot to start tracker',
  'forgot tracker',
  'manual',
  'manual time',
  'lunch',
  'meeting',
  'work',
  'time',
];

export function triageRequest(input: TriageRequestInput): TriageResult {
  const signals: TriageSignal[] = [];
  const durationMs = Math.max(0, input.requestedEndMs - input.requestedStartMs);
  const durationH = durationMs / MS_PER_HOUR;
  const ctx = input.context;

  // 1. Duration vs. user's typical day.
  const avgH = ctx.avgDailyTotalMs / MS_PER_HOUR;
  if (durationH <= 4) {
    // Anything ≤ 4h is "plausible" — most forgotten-tracker windows are short.
    signals.push({
      id: 'duration_in_range',
      text: `${durationH.toFixed(1)}h request — within a typical work block`,
      weight: 0.6,
    });
  } else if (avgH > 0 && durationH > avgH * 1.5) {
    signals.push({
      id: 'duration_out_of_range',
      text: `${durationH.toFixed(1)}h request — well above their ${avgH.toFixed(1)}h average day`,
      weight: -0.8,
    });
  } else {
    signals.push({
      id: 'duration_in_range',
      text: `${durationH.toFixed(1)}h request — reasonable for the day`,
      weight: 0.3,
    });
  }

  // 2. Adjacency to existing AUTO time.
  if (ctx.closestAutoEdgeMs <= 30 * 60 * 1000) {
    signals.push({
      id: 'adjacent_to_auto',
      text: 'Borders existing tracked time — looks like a true gap',
      weight: 0.8,
    });
  } else if (ctx.autoTrackedSameDayMs === 0) {
    signals.push({
      id: 'isolated_from_auto',
      text: 'No AUTO time tracked that day — couldn\'t cross-reference',
      weight: -0.4,
    });
  } else {
    signals.push({
      id: 'isolated_from_auto',
      text: 'Far from any AUTO segment — manual time stands alone',
      weight: -0.2,
    });
  }

  // 3. Reason quality.
  const reasonClean = input.reason.trim();
  const reasonLower = reasonClean.toLowerCase();
  const wordCount = reasonClean.split(/\s+/).filter(Boolean).length;
  if (reasonClean.length < 5) {
    signals.push({
      id: 'reason_short',
      text: 'Reason is suspiciously brief',
      weight: -0.5,
    });
  } else if (GENERIC_REASONS.includes(reasonLower) || wordCount <= 2) {
    signals.push({
      id: 'reason_generic',
      text: 'Reason reads as generic / templated',
      weight: -0.3,
    });
  } else {
    signals.push({
      id: 'reason_substantive',
      text: 'Reason has detail',
      weight: 0.4,
    });
  }

  // 4. Approval / rejection history.
  if (ctx.rejectedLast30Days >= 3) {
    signals.push({
      id: 'frequent_rejections',
      text: `${ctx.rejectedLast30Days} prior rejections in the last 30 days`,
      weight: -0.6,
    });
  } else if (ctx.approvedLast30Days >= 3 && ctx.rejectedLast30Days === 0) {
    signals.push({
      id: 'clean_history',
      text: `Clean record — ${ctx.approvedLast30Days} prior approvals, no rejections`,
      weight: 0.4,
    });
  }

  // 5. Request age — surface "needs human eyes" if stuck.
  if (ctx.requestAgeMs >= 72 * MS_PER_HOUR) {
    signals.push({
      id: 'request_stuck',
      text: 'Waiting > 3 days — please decide soon',
      weight: -0.1,
    });
  }

  // Sum signals. Map to verdict + confidence.
  const score = signals.reduce((acc, s) => acc + s.weight, 0);
  let verdict: TriageVerdict;
  if (score >= 0.8) verdict = 'approve';
  else if (score <= -0.5) verdict = 'reject';
  else verdict = 'review';

  // Confidence: |score| normalized, clamped [0, 1]. Reviewers see < ~0.4
  // as the "neutral" zone.
  const confidence = Math.min(1, Math.abs(score) / 1.8);

  const headline = headlineFor(verdict, signals);

  return { verdict, confidence, signals, headline };
}

function headlineFor(verdict: TriageVerdict, signals: TriageSignal[]): string {
  const top = [...signals].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))[0];
  const lead = top?.text ?? 'No notable signals';
  if (verdict === 'approve') return `Likely safe — ${lead.toLowerCase()}`;
  if (verdict === 'reject') return `Worth pushing back — ${lead.toLowerCase()}`;
  return `Take a look — ${lead.toLowerCase()}`;
}
