import { useEffect, useState } from 'react';
import { Keyboard, MousePointer2, X } from 'lucide-react';
import { formatWorkspaceDateTime, formatWorkspaceTime } from '../lib/workspaceTime';

export type ShotItem = {
  id: string;
  capturedAt: number;
  thumb: string | null;
  uploadState: string;
  keyboardPct: number;
  mousePct: number;
  attempts: number;
  lastError: string | null;
};

/** Grid of screenshot thumbnails with per-shot keyboard/mouse activity bars.
 *  Clicking a shot opens a full-resolution lightbox. Shared by Today + Reports. */
export default function ScreenshotGrid({ shots, timeZone }: { shots: ShotItem[]; timeZone: string }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [full, setFull] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!openId) return;
    let alive = true;
    setFull(null);
    setLoading(true);
    void window.agent.screenshots.full(openId).then((url) => {
      if (alive) { setFull(url); setLoading(false); }
    });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenId(null); };
    document.addEventListener('keydown', onKey);
    return () => { alive = false; document.removeEventListener('keydown', onKey); };
  }, [openId]);

  const openShot = openId ? shots.find((s) => s.id === openId) : undefined;

  return (
    <>
      <div className="shot-grid">
        {shots.map((s) => (
          <button
            key={s.id}
            className="shot shot-btn"
            title={[
              formatWorkspaceDateTime(s.capturedAt, timeZone),
              uploadLabel(s.uploadState),
              s.lastError ? s.lastError : null,
              `keyboard ${s.keyboardPct}%`,
              `mouse ${s.mousePct}%`,
            ].filter(Boolean).join(' · ')}
            onClick={() => setOpenId(s.id)}
          >
            {s.thumb ? <img src={s.thumb} alt="screenshot" /> : <div className="shot-missing" />}
            <div className="shot-act">
              <span className="shot-act-row"><Keyboard size={11} strokeWidth={2} /><span className="shot-act-track"><span className="shot-act-fill kb" style={{ width: `${s.keyboardPct}%` }} /></span></span>
              <span className="shot-act-row"><MousePointer2 size={11} strokeWidth={2} /><span className="shot-act-track"><span className="shot-act-fill ms" style={{ width: `${s.mousePct}%` }} /></span></span>
            </div>
            <span className="shot-time">{formatWorkspaceTime(s.capturedAt, timeZone)}</span>
            {s.uploadState !== 'uploaded' && <span className="shot-upload">{uploadLabel(s.uploadState)}</span>}
          </button>
        ))}
      </div>

      {openId && (
        <div className="lightbox" onClick={() => setOpenId(null)} role="dialog" aria-modal="true">
          <button className="lightbox-close no-drag" onClick={() => setOpenId(null)} aria-label="Close"><X size={20} strokeWidth={2.5} /></button>
          <div className="lightbox-body" onClick={(e) => e.stopPropagation()}>
            {loading && <div className="lightbox-loading">Loading…</div>}
            {!loading && full && <img src={full} alt="screenshot" className="lightbox-img" />}
            {!loading && !full && <div className="lightbox-loading">Couldn’t load this screenshot.</div>}
            {openShot && (
              <div className="lightbox-meta">
                {formatWorkspaceDateTime(openShot.capturedAt, timeZone)} · keyboard {openShot.keyboardPct}% · mouse {openShot.mousePct}%
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function uploadLabel(state: string): string {
  if (state === 'uploaded') return 'Uploaded';
  if (state === 'uploading') return 'Uploading';
  if (state === 'failed') return 'Upload failed';
  return 'Pending upload';
}
