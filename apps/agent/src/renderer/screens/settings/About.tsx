import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, DownloadCloud } from 'lucide-react';
import { settingsUpdateSubtitle, updateAction, updatePercent } from '../../lib/updateUi';

/** Updates and the installed version. */
export default function AboutSection() {
  const qc = useQueryClient();
  const info = useQuery({ queryKey: ['settings'], queryFn: () => window.agent.settings.get(), refetchInterval: 4000 });
  const updates = useQuery({ queryKey: ['updates'], queryFn: () => window.agent.updates.status(), refetchInterval: 60_000 });
  const checkUpdates = useMutation({
    mutationFn: () => window.agent.updates.checkNow(),
    onSuccess: (s) => qc.setQueryData(['updates'], s),
  });
  const installUpdate = useMutation({
    mutationFn: () => window.agent.updates.installNow(),
    onSuccess: (s) => qc.setQueryData(['updates'], s),
  });

  const u = updates.data;
  const updateBusy = u?.phase === 'checking' || u?.phase === 'downloading' || u?.phase === 'installing' || checkUpdates.isPending;
  const updatePercentValue = updatePercent(u);
  const updateSub = settingsUpdateSubtitle(u);
  const updateButton = updateAction(u, updateBusy || installUpdate.isPending);

  return (
    <div className="set-card">
      <div className="set-row">
        <span className="set-ic">
          {u?.phase === 'ready' || u?.phase === 'installing' ? <DownloadCloud size={17} strokeWidth={2} /> : <RefreshCw size={17} strokeWidth={2} />}
        </span>
        <div className="set-main">
          <div className="set-title">Updates</div>
          <div className="set-sub secondary">
            {updateSub}
            {u?.phase === 'downloading' && (
              <span className="update-progress" aria-label={`Downloading ${updatePercentValue}%`}>
                <span style={{ width: `${updatePercentValue}%` }} />
              </span>
            )}
            {u?.phase === 'error' && u.manual && u.error ? ` · ${u.error}` : ''}
          </div>
        </div>
        {updateButton.kind === 'restart' ? (
          <button
            className="btn btn-prominent no-drag"
            onClick={() => installUpdate.mutate()}
            disabled={updateButton.disabled}
          >
            {updateButton.label}
          </button>
        ) : updateButton.kind === 'check' ? (
          <button
            className="btn no-drag"
            onClick={() => checkUpdates.mutate()}
            disabled={updateButton.disabled}
          >
            {updateButton.label}
          </button>
        ) : null}
      </div>
      <div className="set-row">
        <div className="set-main">
          <div className="set-title">Timo</div>
          <div className="set-sub secondary">Version {info.data?.version ?? '—'} · {info.data?.platform ?? ''}</div>
        </div>
      </div>
    </div>
  );
}
