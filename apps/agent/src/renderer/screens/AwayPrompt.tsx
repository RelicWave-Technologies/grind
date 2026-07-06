import { useMutation, useQuery } from '@tanstack/react-query';
import { Coffee } from 'lucide-react';

/**
 * "Welcome back — resume tracking?" toast. Shown at top-right after the user
 * returns from a lock/sleep that stopped a running timer. Resume starts a fresh
 * entry on the same task (the away gap was never billed); Not now dismisses.
 */
function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export default function AwayPrompt() {
  const info = useQuery({ queryKey: ['away'], queryFn: () => window.agent.away.get() });
  const larkTasks = useQuery({ queryKey: ['larkTasks'], queryFn: () => window.agent.lark.tasks() });
  const resume = useMutation({ mutationFn: () => window.agent.away.resume() });
  const dismiss = useMutation({ mutationFn: () => window.agent.away.dismiss() });

  const data = info.data ?? null;
  const guid = data?.larkTaskGuid ?? null;
  const task = guid ? larkTasks.data?.tasks.find((t) => t.guid === guid) : undefined;
  const reasonText = data?.reason === 'suspend' ? 'your computer slept' : 'your screen locked';
  const when = data ? ` at ${fmtTime(data.stoppedAt)}` : '';
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
