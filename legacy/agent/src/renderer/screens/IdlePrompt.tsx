import { useMemo } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Coffee } from 'lucide-react';
import type { AttentionPrompt } from '../../shared/attention';

function fmtAgo(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  // Under a minute: show the real seconds, matching the idle threshold
  // (e.g. "15 seconds") instead of rounding up to a minute.
  if (totalSec < 60) return `${totalSec} second${totalSec === 1 ? '' : 's'}`;
  const min = Math.floor(totalSec / 60);
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'}`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Shown after the idle threshold. The timer is already PAUSED (idle time is
 * never counted). The user either continues (resume) or takes a break (stop).
 *
 * The label shows how long you'd been idle WHEN the prompt appeared — a stable
 * snapshot, not a live counter. (It used to tick up every second, so a prompt
 * left on screen would balloon to "11 minutes" while you read it.)
 */
export default function IdlePrompt({ prompt }: { prompt: Extract<AttentionPrompt, { kind: 'IDLE' }> }) {
  const resolve = useMutation({
    mutationFn: (action: 'IDLE_CONTINUE' | 'IDLE_BREAK') =>
      window.agent.attention.resolve(prompt.promptId, action),
  });

  const idleStart = prompt.idleStartedAt;
  // Snapshot the elapsed idle once, at the moment we learn the idle-start —
  // not on an interval. Recomputes only when a fresh prompt provides a new
  // idleStartedAt.
  const awayMs = useMemo(
    () => (idleStart == null ? 0 : Math.max(0, Date.now() - idleStart)),
    [idleStart],
  );

  return (
    <div className="idle">
      <span className="idle-icon"><Coffee size={24} strokeWidth={2} /></span>
      <div className="h3">Timer paused</div>
      <div className="idle-sub callout secondary">
        No activity for <b>{fmtAgo(awayMs)}</b>. This idle time isn&rsquo;t counted.
      </div>
      <div className="idle-actions">
        <button className="btn no-drag" onClick={() => resolve.mutate('IDLE_BREAK')} disabled={resolve.isPending}>
          Take a break
        </button>
        <button className="btn btn-prominent no-drag" onClick={() => resolve.mutate('IDLE_CONTINUE')} disabled={resolve.isPending}>
          Continue
        </button>
      </div>
    </div>
  );
}
