import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Coffee } from 'lucide-react';

function fmtAgo(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 1) return 'less than a minute';
  if (min === 1) return '1 minute';
  if (min < 60) return `${min} minutes`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** "Are you still working?" — shown after the idle threshold. */
export default function IdlePrompt() {
  const info = useQuery({ queryKey: ['idle'], queryFn: () => window.agent.idle.get() });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const resolve = useMutation({ mutationFn: (a: 'keep' | 'discard') => window.agent.idle.resolve(a) });
  const idleStart = info.data?.idleStartedAt ?? now;
  const awayMs = Math.max(0, now - idleStart);

  return (
    <div className="idle">
      <span className="idle-icon"><Coffee size={24} strokeWidth={2} /></span>
      <div className="idle-title h3">Are you still working?</div>
      <div className="idle-sub callout secondary">
        No activity for <b>{fmtAgo(awayMs)}</b>. Keep this time or discard it?
      </div>
      <div className="idle-actions">
        <button className="btn no-drag" onClick={() => resolve.mutate('discard')} disabled={resolve.isPending}>
          Discard idle
        </button>
        <button className="btn btn-prominent no-drag" onClick={() => resolve.mutate('keep')} disabled={resolve.isPending}>
          Keep working
        </button>
      </div>
    </div>
  );
}
