import { useMutation, useQuery } from '@tanstack/react-query';
import { Coffee } from 'lucide-react';
import type { AttentionPrompt } from '../../shared/attention';
import { formatWorkspaceTime, useWorkspaceTime } from '../lib/workspaceTime';

/**
 * "Welcome back — resume tracking?" toast. Shown at top-right after the user
 * returns from a lock/sleep that stopped a running timer. Resume starts a fresh
 * entry on the same task (the away gap was never billed); Not now dismisses.
 */
export default function AwayPrompt({ prompt }: { prompt: Extract<AttentionPrompt, { kind: 'AWAY' }> }) {
  const larkTasks = useQuery({ queryKey: ['larkTasks'], queryFn: () => window.agent.lark.tasks() });
  const workspaceTime = useWorkspaceTime();
  const resume = useMutation({ mutationFn: () => window.agent.attention.resolve(prompt.promptId, 'AWAY_RESUME') });
  const dismiss = useMutation({ mutationFn: () => window.agent.attention.resolve(prompt.promptId, 'AWAY_DISMISS') });

  const guid = prompt.larkTaskGuid;
  const task = guid ? larkTasks.data?.tasks.find((t) => t.guid === guid) : undefined;
  const reasonText = prompt.reason === 'suspend' ? 'your computer slept' : 'your screen locked';
  const when = ` at ${formatWorkspaceTime(prompt.stoppedAt, workspaceTime.data?.timeZone ?? null)}`;
  const busy = resume.isPending || dismiss.isPending;

  return (
    <div className="rtw">
      <div className="rtw-head">
        <span className="rtw-icon" aria-hidden>
          <Coffee size={20} strokeWidth={2} />
        </span>
        <div className="rtw-title">
          <div className="h3">Welcome back</div>
          <div className="rtw-sub callout secondary">
            Tracking stopped when {reasonText}{when}. Resume{task ? ` “${task.summary}”` : ' tracking'}?
          </div>
        </div>
      </div>
      <div className="rtw-actions">
        <button className="btn no-drag" onClick={() => dismiss.mutate()} disabled={busy}>
          Not now
        </button>
        <button className="btn btn-prominent no-drag" onClick={() => resume.mutate()} disabled={busy}>
          Resume
        </button>
      </div>
    </div>
  );
}
