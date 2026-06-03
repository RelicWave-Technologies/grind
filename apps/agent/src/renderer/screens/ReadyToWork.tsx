import { useMutation } from '@tanstack/react-query';
import { Sunrise } from 'lucide-react';

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
export default function ReadyToWork() {
  const decide = useMutation({
    mutationFn: (d: 'yes' | 'not_yet') => window.agent.shift.decide(d),
  });

  return (
    <div className="rtw">
      <div className="rtw-head">
        <span className="rtw-icon" aria-hidden>
          <Sunrise size={20} strokeWidth={2} />
        </span>
        <div className="rtw-title">
          <div className="h3">Ready to work?</div>
          <div className="rtw-sub callout secondary">Your shift just started. Want to clock in?</div>
        </div>
      </div>
      <div className="rtw-actions">
        <button
          className="btn no-drag"
          onClick={() => decide.mutate('not_yet')}
          disabled={decide.isPending}
        >
          Not yet
        </button>
        <button
          className="btn btn-prominent no-drag"
          onClick={() => decide.mutate('yes')}
          disabled={decide.isPending}
        >
          Yes, start
        </button>
      </div>
    </div>
  );
}
