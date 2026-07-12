import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Camera, ShieldAlert, RefreshCw } from 'lucide-react';
import ScreenshotGrid from './ScreenshotGrid';

export default function ScreenshotsStrip() {
  const qc = useQueryClient();
  const permissions = useQuery({
    queryKey: ['trackingReadiness'],
    queryFn: () => window.agent.permissions.readiness(),
    refetchInterval: 4000,
  });
  const shots = useQuery({
    queryKey: ['screenshots'],
    queryFn: () => window.agent.screenshots.recent(8),
    refetchInterval: 5000,
  });
  const uploads = useQuery({
    queryKey: ['screenshotsUploadSummary'],
    queryFn: () => window.agent.screenshots.uploadSummary(),
    refetchInterval: 5000,
  });

  const capture = useMutation({
    mutationFn: () => window.agent.screenshots.captureOnce(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['screenshots'] });
      void qc.invalidateQueries({ queryKey: ['screenshotsUploadSummary'] });
      void qc.invalidateQueries({ queryKey: ['trackingReadiness'] });
    },
  });
  const retryFailed = useMutation({
    mutationFn: () => window.agent.screenshots.retryFailedUploads(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['screenshots'] });
      void qc.invalidateQueries({ queryKey: ['screenshotsUploadSummary'] });
    },
  });

  const screenState = permissions.data?.screenRecording ?? 'NEEDS_GRANT';
  const state = screenState === 'READY' || screenState === 'NOT_REQUIRED'
    ? 'ok'
    : screenState === 'NEEDS_GRANT'
      ? 'needs-grant'
      : screenState === 'NEEDS_SETTINGS'
        ? 'needs-settings'
        : 'needs-restart';
  const ok = state === 'ok';
  const failedUploads = uploads.data?.failed ?? 0;

  return (
    <>
      <div className="section-head">
        <span className="section-title">Screenshots</span>
        <button className="see-all" onClick={() => capture.mutate()} disabled={capture.isPending}>
          {capture.isPending ? 'Capturing…' : 'Take one now'}
        </button>
      </div>

      {!ok && <PermBanner state={state} />}
      {ok && failedUploads > 0 && (
        <div className="perm-banner">
          <ShieldAlert size={18} strokeWidth={2} />
          <div style={{ flex: 1 }}>
            <div className="callout" style={{ fontWeight: 600 }}>Upload failed</div>
            <div className="small secondary">{failedUploads} screenshot{failedUploads === 1 ? '' : 's'} need a manual retry.</div>
          </div>
          <button className="btn no-drag" onClick={() => retryFailed.mutate()} disabled={retryFailed.isPending}>
            {retryFailed.isPending ? 'Retrying…' : 'Retry uploads'}
          </button>
        </div>
      )}

      {ok &&
        (shots.data && shots.data.length > 0 ? (
          <ScreenshotGrid shots={shots.data} />
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
      body: 'Click “Take one now”, then allow Timo under Screen Recording.',
      label: 'Open System Settings',
      run: () => window.agent.permissions.requestScreen(),
    },
    'needs-settings': {
      title: 'Screen Recording permission needed',
      body: 'Enable Timo under System Settings → Privacy & Security → Screen Recording.',
      label: 'Open System Settings',
      run: () => window.agent.settings.openScreenPrefs(),
    },
    'needs-restart': {
      title: 'Restart to finish enabling screenshots',
      body: 'Permission changed — Timo needs a restart for screen capture to take effect.',
      label: 'Restart Timo',
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
