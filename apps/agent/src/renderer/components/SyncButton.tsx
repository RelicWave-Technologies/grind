import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, AlertCircle, Link2 } from 'lucide-react';

/**
 * Manual Lark sync: re-checks the connection and re-pulls tasks (the main
 * process retries transient failures up to 3×). Surfaces three outcomes:
 *   • success    → seeds the larkTasks cache + shows a brief "Synced".
 *   • reauth     → swaps to a "Reconnect Lark" action.
 *   • failure    → inline error with a manual Retry.
 *
 * Shared by the Today (main) and Tasks screens so both stay in sync.
 */
export default function SyncButton(): JSX.Element {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [reauth, setReauth] = useState(false);
  const [justSynced, setJustSynced] = useState(false);

  const sync = useMutation({
    mutationFn: () => window.agent.lark.sync(),
    onMutate: () => {
      setError(null);
      setReauth(false);
    },
    onSuccess: (res) => {
      if (res.ok) {
        qc.setQueryData(['larkTasks'], { tasks: res.tasks, reauthRequired: false });
        void qc.invalidateQueries({ queryKey: ['larkStatus'] });
        setJustSynced(true);
      } else if (res.reauthRequired) {
        setReauth(true);
      } else if (!res.connected) {
        setReauth(true);
      } else {
        setError(res.error || 'Sync failed');
      }
    },
    onError: (e) => setError(String(e)),
  });

  const connect = useMutation({
    mutationFn: () => window.agent.lark.connect(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['larkStatus'] }),
  });

  // Clear the transient "Synced" confirmation after a moment.
  useEffect(() => {
    if (!justSynced) return;
    const t = window.setTimeout(() => setJustSynced(false), 2500);
    return () => window.clearTimeout(t);
  }, [justSynced]);

  if (reauth) {
    return (
      <button
        className="btn btn-soft no-drag"
        onClick={() => connect.mutate()}
        disabled={connect.isPending}
        title="Your Lark session expired — reconnect to sync"
      >
        <Link2 size={14} strokeWidth={2.5} /> {connect.isPending ? 'Opening…' : 'Reconnect Lark'}
      </button>
    );
  }

  return (
    <span className="sync-wrap no-drag">
      <button
        className="btn btn-soft no-drag"
        onClick={() => sync.mutate()}
        disabled={sync.isPending}
        title="Refresh Lark connection and tasks"
      >
        <RefreshCw size={14} strokeWidth={2.5} className={sync.isPending ? 'spin' : ''} />
        {sync.isPending ? 'Syncing…' : 'Sync'}
      </button>
      {error ? (
        <span className="sync-msg sync-msg-error" title={error}>
          <AlertCircle size={12} strokeWidth={2.5} /> Failed ·{' '}
          <button className="linklike" onClick={() => sync.mutate()}>Retry</button>
        </span>
      ) : justSynced ? (
        <span className="sync-msg sync-msg-ok">Synced</span>
      ) : null}
    </span>
  );
}
