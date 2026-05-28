import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Camera, ShieldAlert } from 'lucide-react';

export default function ScreenshotsStrip() {
  const qc = useQueryClient();
  const perm = useQuery({ queryKey: ['screenPerm'], queryFn: () => window.agent.permissions.screenStatus() });
  const shots = useQuery({
    queryKey: ['screenshots'],
    queryFn: () => window.agent.screenshots.recent(8),
    refetchInterval: 5000,
  });

  const capture = useMutation({
    mutationFn: () => window.agent.screenshots.captureOnce(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['screenshots'] }),
  });

  const granted = perm.data === 'granted';

  return (
    <>
      <div className="section-head">
        <span className="section-title">Screenshots</span>
        <button className="see-all" onClick={() => capture.mutate()} disabled={capture.isPending}>
          {capture.isPending ? 'Capturing…' : 'Take one now'}
        </button>
      </div>

      {!granted && (
        <div className="perm-banner">
          <ShieldAlert size={18} strokeWidth={2} />
          <div style={{ flex: 1 }}>
            <div className="callout" style={{ fontWeight: 600 }}>Screen Recording permission needed</div>
            <div className="small secondary">
              Enable Grind under System Settings → Privacy &amp; Security → Screen Recording, then restart the app.
            </div>
          </div>
        </div>
      )}

      {granted && (
        <>
          {shots.data && shots.data.length > 0 ? (
            <div className="shot-grid">
              {shots.data.map((s) => (
                <div key={s.id} className="shot" title={new Date(s.capturedAt).toLocaleString()}>
                  {s.thumb ? <img src={s.thumb} alt="screenshot" /> : <div className="shot-missing" />}
                  <span className="shot-time">{new Date(s.capturedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="shot-empty callout secondary">
              <Camera size={16} strokeWidth={1.75} /> No screenshots yet — they’re captured periodically while you track.
            </div>
          )}
        </>
      )}
    </>
  );
}
