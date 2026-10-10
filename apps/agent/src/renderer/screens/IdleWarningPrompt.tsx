import { useEffect, useId, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Clock3 } from 'lucide-react';
import type { AttentionPrompt } from '../../shared/attention';
import { countdownAnnouncement, usePromptKeys } from '../lib/promptA11y';

function secondsRemaining(deadlineAt: number): number {
  return Math.max(0, Math.ceil((deadlineAt - Date.now()) / 1000));
}

export default function IdleWarningPrompt({
  prompt,
}: {
  prompt: Extract<AttentionPrompt, { kind: 'IDLE_WARNING' }>;
}) {
  const titleId = useId();
  const subId = useId();
  const [remaining, setRemaining] = useState(() => secondsRemaining(prompt.deadlineAt));
  // The visible number ticks every second; what is read aloud does not.
  const [spoken, setSpoken] = useState(() => countdownAnnouncement(remaining, true) ?? '');
  const confirm = useMutation({
    mutationFn: () => window.agent.attention.resolve(prompt.promptId, 'IDLE_WARNING_CONTINUE'),
  });
  const keepWorking = () => confirm.mutate();
  // One answer only: dismissing the warning is saying "still working".
  usePromptKeys({ primary: keepWorking, secondary: keepWorking, disabled: confirm.isPending });

  useEffect(() => {
    const initial = secondsRemaining(prompt.deadlineAt);
    setRemaining(initial);
    setSpoken(countdownAnnouncement(initial, true) ?? '');
    const timer = window.setInterval(
      () => setRemaining(secondsRemaining(prompt.deadlineAt)),
      250,
    );
    return () => window.clearInterval(timer);
  }, [prompt.deadlineAt]);

  useEffect(() => {
    const text = countdownAnnouncement(remaining, false);
    if (text) setSpoken(text);
  }, [remaining]);

  return (
    <div className="idle" role="dialog" aria-labelledby={titleId} aria-describedby={subId}>
      <span className="idle-icon" aria-hidden><Clock3 size={24} strokeWidth={2} /></span>
      <div className="h3" id={titleId}>Are you still working?</div>
      <div className="idle-countdown" aria-hidden>{remaining}s</div>
      <div className="sr-only" aria-live="polite">{spoken}</div>
      <div className="idle-sub callout secondary" id={subId}>
        Timo will pause when the countdown ends.
      </div>
      <div className="idle-actions">
        <button
          className="btn btn-prominent no-drag"
          onClick={keepWorking}
          disabled={confirm.isPending}
          autoFocus
        >
          Still working
        </button>
      </div>
    </div>
  );
}
