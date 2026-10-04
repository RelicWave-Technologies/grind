import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, AlertCircle } from 'lucide-react';
import larkIcon from '../../assets/lark.svg';

/** The Lark connection your tasks come from. */
export default function IntegrationsSection() {
  const qc = useQueryClient();
  const lark = useQuery({ queryKey: ['larkStatus'], queryFn: () => window.agent.lark.status(), refetchInterval: 4000 });
  const connectLark = useMutation({
    mutationFn: () => window.agent.lark.connect(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['larkStatus'] }),
  });
  const disconnectLark = useMutation({
    mutationFn: () => window.agent.lark.disconnect(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['larkStatus'] }),
  });

  useEffect(() => {
    return window.agent.lark.onConnectionChange(() => {
      void qc.invalidateQueries({ queryKey: ['larkStatus'] });
      void qc.invalidateQueries({ queryKey: ['larkTasks'] });
    });
  }, [qc]);

  const l = lark.data;
  const larkConnected = !!l?.connected;
  const larkReauth = !!l?.reauthRequired;
  const larkSub = !l?.configured
    ? { ok: false, text: 'Not configured by your workspace' }
    : larkReauth
      ? { ok: false, text: 'Reconnect needed — your Lark access changed or expired' }
      : larkConnected
        ? { ok: true, text: 'Connected' }
        : { ok: false, text: 'Connect to attribute time to Lark tasks' };

  return (
    <div className="set-card">
      <div className="set-row">
        <span className="set-ic">
          <img className="lark-icon lark-icon--setting" src={larkIcon} alt="" />
        </span>
        <div className="set-main">
          <div className="set-title">Lark</div>
          <div className="set-sub">
            {larkSub.ok ? (
              <span className="set-ok"><CheckCircle2 size={13} /> {larkSub.text}</span>
            ) : l?.configured === false ? (
              <span className="set-sub secondary">{larkSub.text}</span>
            ) : (
              <span className="set-warn"><AlertCircle size={13} /> {larkSub.text}</span>
            )}
          </div>
        </div>
        {l?.configured === false ? null : larkConnected && !larkReauth ? (
          <button
            className="btn no-drag"
            onClick={() => disconnectLark.mutate()}
            disabled={disconnectLark.isPending}
          >
            Disconnect
          </button>
        ) : (
          <button
            className="btn btn-prominent no-drag"
            onClick={() => connectLark.mutate()}
            disabled={connectLark.isPending}
          >
            {larkReauth ? 'Reconnect' : connectLark.isPending ? 'Opening…' : 'Connect'}
          </button>
        )}
      </div>
    </div>
  );
}
