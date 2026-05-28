import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Camera, ShieldAlert, RefreshCw } from 'lucide-react';

export default function ScreenshotsStrip() {
  const qc = useQueryClient();
  const perm = useQuery({
    queryKey: ['screenPerm'],
    queryFn: () => window.agent.permissions.screen(),
    refetchInterval: 4000,
  });
  const shots = useQuery({
    queryKey: ['screenshots'],
    queryFn: () => window.agent.screenshots.recent(8),
    refetchInterval: 5000,
  });

  const capture = useMutation({
    mutationFn: () => window.agent.screenshots.captureOnce(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['screenshots'] });
      void qc.invalidateQueries({ queryKey: ['screenPerm'] });
    },
  });

  const state = perm.data?.state ?? 'ok';
  const ok = state === 'ok';

  return (
    <>
      <div className="section-head">
        <span className="section-title">Screenshots</span>
        <button className="see-all" onClick={() => capture.mutate()} disabled={capture.isPending}>
          {capture.isPending ? 'Capturing…' : 'Take one now'}
        </button>
      </div>

      {!ok && <PermBanner state={state} />}

      {ok &&
        (shots.data && shots.data.length > 0 ? (
          <div className="shot-grid">
            {shots.data.map((s) => (
              <div key={s.id} className="shot" title={new Date(s.capturedAt).toLocaleString()}>
                {s.thumb ? <img src={s.thumb} alt="screenshot" /> : <div className="shot-missing" />}
                <span className="shot-time">
                  {new Date(s.capturedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="shot-empty callout secondary">
            <Camera size={16} strokeWidth={1.75} /> No screenshots yet — captured periodically while you track.
          </div>
        ))}
    </>
  );
}

function PermBanner({ state }: { state: 'needs-grant' | 'needs-settings' | 'needs-restart' }) {
  const copy = {
    'needs-grant': {
      title: 'Enable screenshots',
      body: 'Click “Take one now”, then allow Grind under Screen Recording.',
      label: 'Open System Settings',
      run: () => window.agent.settings.openScreenPrefs(),
    },
    'needs-settings': {
      title: 'Screen Recording permission needed',
      body: 'Enable Grind under System Settings → Privacy & Security → Screen Recording.',
      label: 'Open System Settings',
      run: () => window.agent.settings.openScreenPrefs(),
    },
    'needs-restart': {
      title: 'Restart to finish enabling screenshots',
      body: 'Permission changed — Grind needs a restart for screen capture to take effect.',
      label: 'Restart Grind',
      run: () => window.agent.app.relaunch(),
    },
  }[state];

  return (
    <div className="perm-banner">
      {state === 'needs-restart' ? <RefreshCw size={18} strokeWidth={2} /> : <ShieldAlert size={18} strokeWidth={2} />}
      <div style={{ flex: 1 }}>
        <div className="callout" style={{ fontWeight: 600 }}>{copy.title}</div>
        <div className="small secondary">{copy.body}</div>
      </div>
      <button className="btn no-drag" onClick={copy.run}>{copy.label}</button>
    </div>
  );
}
