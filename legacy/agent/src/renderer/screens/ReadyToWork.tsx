import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Sunrise, Timer } from 'lucide-react';

/**
 * Toast that appears when the user's shift window opens (start +
 * bufferMin). Two choices:
 *   - **Yes** → opens the main agent window (the picker / Today screen).
 *     The popup hides; ShiftMonitor ack-marks today as handled.
 *   - **Not yet** → 5-min snooze. Popup hides; if the user is still inside
 *     the buffer when the snooze expires, it re-shows.
 *
 * The window is a top-right frameless `panel`, focus-non-stealing (we
 * notify, don't interrupt). Renderer-side bookkeeping is minimal — all
 * lifecycle logic lives in the main-process ShiftMonitor.
 */
const COPY = {
  SHIFT_START: {
    icon: Sunrise,
    title: 'Ready to work?',
    sub: 'Your shift just started. Want to clock in?',
    confirm: 'Yes, start',
    dismiss: 'Not yet',
  },
  UNTRACKED: {
    icon: Timer,
    title: 'Are you working?',
    sub: "You've been active for a while with no timer running.",
    confirm: 'Start tracking',
    dismiss: 'Not now',
  },
} as const;

export default function ReadyToWork() {
  const qc = useQueryClient();
  const decide = useMutation({
    mutationFn: (d: 'yes' | 'not_yet') => window.agent.shift.decide(d),
  });
  const reason = useQuery({
    queryKey: ['shiftPromptReason'],
    queryFn: () => window.agent.shift.promptReason(),
    staleTime: 0,
  });

  useEffect(() => window.agent.shift.onPromptReason((next) => {
    qc.setQueryData(['shiftPromptReason'], next);
  }), [qc]);

  const copy = COPY[reason.data ?? 'SHIFT_START'];
  const Icon = copy.icon;

  return (
    <div className="rtw">
      <div className="rtw-head">
        <span className="rtw-icon" aria-hidden>
          <Icon size={20} strokeWidth={2} />
        </span>
        <div className="rtw-title">
          <div className="h3">{copy.title}</div>
          <div className="rtw-sub callout secondary">{copy.sub}</div>
        </div>
      </div>
      <div className="rtw-actions">
        <button
          className="btn no-drag"
          onClick={() => decide.mutate('not_yet')}
          disabled={decide.isPending}
        >
          {copy.dismiss}
        </button>
        <button
          className="btn btn-prominent no-drag"
          onClick={() => decide.mutate('yes')}
          disabled={decide.isPending}
        >
          {copy.confirm}
        </button>
      </div>
    </div>
  );
}
