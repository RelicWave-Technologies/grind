/**
 * Floating dev panel for mock mode. Rendered into its own shadow root (see
 * mount.tsx) with its own `mockpanel-` styles, so a global restyle of the
 * dashboard can never reach it — and it can never leak into the dashboard.
 */
import { useEffect, useState } from 'react';
import type { Role } from '@grind/types';
import { resetDb } from '../db';
import { PEOPLE, ROLE_PERSONA } from '../people';
import { selfTest, type SelfTestReport } from '../selftest';
import { getSettings, subscribeSettings, updateSettings, type MockSettings } from '../settings';

const ROLES: Role[] = ['ADMIN', 'MANAGER', 'MEMBER'];
const LATENCIES: Array<{ value: MockSettings['latencyMs']; label: string }> = [
  { value: 0, label: '0' },
  { value: 800, label: '800ms' },
  { value: 3000, label: '3s' },
];

function personaName(role: Role): string {
  return PEOPLE.find((p) => p.id === ROLE_PERSONA[role])?.name ?? role;
}

function reload(): void {
  window.location.reload();
}

export function DevPanel() {
  const [s, setS] = useState<MockSettings>(getSettings());
  const [report, setReport] = useState<SelfTestReport | null>(null);
  useEffect(() => subscribeSettings(setS), []);

  // Alt+Shift+M toggles the panel, for clean screenshots.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.shiftKey && e.code === 'KeyM') updateSettings({ collapsed: !getSettings().collapsed });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const set = (patch: Partial<MockSettings>, thenReload = true) => {
    updateSettings(patch);
    if (thenReload) reload();
  };

  if (s.collapsed) {
    return (
      <button type="button" className="mockpanel-pill" onClick={() => set({ collapsed: false }, false)} title="Timo mock API — click to open (Alt+Shift+M)">
        <span className={`mockpanel-dot${s.errors ? ' is-bad' : s.signedOut ? ' is-off' : ''}`} />
        MOCK · {s.signedOut ? 'SIGNED OUT' : s.role}
        {s.empty && <span className="mockpanel-chip">EMPTY</span>}
        {s.errors && <span className="mockpanel-chip is-bad">500</span>}
        {s.latencyMs > 0 && <span className="mockpanel-chip">{s.latencyMs >= 1000 ? `${s.latencyMs / 1000}s` : `${s.latencyMs}ms`}</span>}
      </button>
    );
  }

  return (
    <section className="mockpanel-card" aria-label="Timo mock API dev panel">
      <header className="mockpanel-head">
        <span className="mockpanel-badge">DEV</span>
        <span className="mockpanel-title">Mock API</span>
        <button type="button" className="mockpanel-icon" onClick={() => set({ collapsed: true }, false)} aria-label="Collapse" title="Collapse (Alt+Shift+M)">
          –
        </button>
      </header>

      <div className="mockpanel-label">Signed in as</div>
      <div className="mockpanel-seg">
        {ROLES.map((role) => (
          <button key={role} type="button" className={`mockpanel-seg-btn${s.role === role ? ' is-on' : ''}`} onClick={() => set({ role, signedOut: false })}>
            {role}
          </button>
        ))}
      </div>
      <div className="mockpanel-hint">{s.signedOut ? 'Nobody — the login screen shows' : personaName(s.role)}</div>

      <label className="mockpanel-row">
        <input type="checkbox" checked={s.signedOut} onChange={(e) => set({ signedOut: e.target.checked })} />
        <span>Signed out</span>
      </label>

      <div className="mockpanel-label">Latency</div>
      <div className="mockpanel-seg">
        {LATENCIES.map((l) => (
          <button key={l.value} type="button" className={`mockpanel-seg-btn${s.latencyMs === l.value ? ' is-on' : ''}`} onClick={() => set({ latencyMs: l.value })}>
            {l.label}
          </button>
        ))}
      </div>

      <label className="mockpanel-row">
        <input type="checkbox" checked={s.empty} onChange={(e) => set({ empty: e.target.checked })} />
        <span>Empty workspace</span>
      </label>
      <label className="mockpanel-row">
        <input type="checkbox" checked={s.errors} onChange={(e) => set({ errors: e.target.checked })} />
        <span>Errors (every request 500)</span>
      </label>

      <div className="mockpanel-actions">
        <button
          type="button"
          className="mockpanel-btn"
          onClick={() => {
            resetDb();
            reload();
          }}
          title="Throw away this tab's edits and regenerate the data"
        >
          Reset data
        </button>
        <button
          type="button"
          className="mockpanel-btn"
          onClick={() => {
            const r = selfTest();
            setReport(r);
            console.info('[timo mock] self-test', r);
          }}
          title="Call every mocked route for every role and check the responses"
        >
          Self-test
        </button>
      </div>
      {report && (
        <div className={`mockpanel-report${report.problems.length || report.uncovered.length || report.unmatched.length ? ' is-bad' : ''}`}>
          {report.calls} calls · {report.problems.length} problems · {report.uncovered.length} untested routes
          {report.problems.length > 0 && ' — see console'}
        </div>
      )}
      <div className="mockpanel-foot">Settings live in localStorage; data edits last for this tab. Unmocked /v1 calls warn in the console.</div>
    </section>
  );
}

export const PANEL_CSS = `
:host { all: initial; }
.mockpanel-pill, .mockpanel-card { font: 12px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #F4F4F5; box-sizing: border-box; }
.mockpanel-pill { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 999px; border: 1px dashed #F59E0B; background: rgba(24, 24, 27, 0.92); cursor: pointer; letter-spacing: .04em; box-shadow: 0 4px 16px rgba(0,0,0,.25); }
.mockpanel-pill:hover { background: #27272A; }
.mockpanel-dot { width: 7px; height: 7px; border-radius: 50%; background: #22C55E; }
.mockpanel-dot.is-off { background: #A1A1AA; }
.mockpanel-dot.is-bad { background: #EF4444; }
.mockpanel-chip { padding: 1px 5px; border-radius: 4px; background: #3F3F46; font-size: 10px; }
.mockpanel-chip.is-bad { background: #7F1D1D; }
.mockpanel-card { width: 248px; padding: 10px 12px 12px; border-radius: 12px; border: 1px dashed #F59E0B; background: rgba(24, 24, 27, 0.96); box-shadow: 0 10px 30px rgba(0,0,0,.35); }
.mockpanel-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.mockpanel-badge { padding: 1px 6px; border-radius: 4px; background: #F59E0B; color: #18181B; font-weight: 700; font-size: 10px; letter-spacing: .08em; }
.mockpanel-title { flex: 1; font-weight: 600; }
.mockpanel-icon { all: unset; cursor: pointer; width: 20px; text-align: center; border-radius: 4px; color: #A1A1AA; font-size: 14px; }
.mockpanel-icon:hover { background: #3F3F46; color: #F4F4F5; }
.mockpanel-label { margin: 8px 0 4px; color: #A1A1AA; font-size: 10px; text-transform: uppercase; letter-spacing: .08em; }
.mockpanel-hint { margin-top: 4px; color: #D4D4D8; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mockpanel-seg { display: flex; gap: 2px; padding: 2px; border-radius: 7px; background: #27272A; }
.mockpanel-seg-btn { all: unset; flex: 1; text-align: center; padding: 4px 0; border-radius: 5px; cursor: pointer; color: #D4D4D8; font-size: 11px; }
.mockpanel-seg-btn:hover { background: #3F3F46; }
.mockpanel-seg-btn.is-on { background: #F59E0B; color: #18181B; font-weight: 700; }
.mockpanel-row { display: flex; align-items: center; gap: 8px; margin-top: 8px; cursor: pointer; user-select: none; }
.mockpanel-row input { margin: 0; accent-color: #F59E0B; }
.mockpanel-actions { display: flex; gap: 6px; margin-top: 12px; }
.mockpanel-btn { all: unset; flex: 1; text-align: center; padding: 5px 0; border-radius: 6px; border: 1px solid #52525B; cursor: pointer; font-size: 11px; color: #F4F4F5; }
.mockpanel-btn:hover { background: #3F3F46; }
.mockpanel-report { margin-top: 8px; padding: 6px 8px; border-radius: 6px; background: #14532D; font-size: 11px; }
.mockpanel-report.is-bad { background: #7F1D1D; }
.mockpanel-foot { margin-top: 10px; color: #71717A; font-size: 10px; line-height: 1.4; }
`;
