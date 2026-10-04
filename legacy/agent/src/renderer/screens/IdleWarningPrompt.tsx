import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Clock3 } from 'lucide-react';
import type { AttentionPrompt } from '../../shared/attention';

function secondsRemaining(deadlineAt: number): number {
  return Math.max(0, Math.ceil((deadlineAt - Date.now()) / 1000));
}

export default function IdleWarningPrompt({
  prompt,
}: {
  prompt: Extract<AttentionPrompt, { kind: 'IDLE_WARNING' }>;
}) {
  const [remaining, setRemaining] = useState(() => secondsRemaining(prompt.deadlineAt));
  const confirm = useMutation({
    mutationFn: () => window.agent.attention.resolve(prompt.promptId, 'IDLE_WARNING_CONTINUE'),
  });

  useEffect(() => {
    setRemaining(secondsRemaining(prompt.deadlineAt));
    const timer = window.setInterval(
      () => setRemaining(secondsRemaining(prompt.deadlineAt)),
      250,
    );
    return () => window.clearInterval(timer);
  }, [prompt.deadlineAt]);

  return (
    <div className="idle">
      <span className="idle-icon"><Clock3 size={24} strokeWidth={2} /></span>
      <div className="h3">Are you still working?</div>
      <div className="idle-countdown" aria-live="polite">{remaining}s</div>
      <div className="idle-sub callout secondary">
        Timo will pause when the countdown ends.
      </div>
      <div className="idle-actions">
        <button
          className="btn btn-prominent no-drag"
          onClick={() => confirm.mutate()}
          disabled={confirm.isPending}
        >
          Still working
        </button>
      </div>
    </div>
  );
}
