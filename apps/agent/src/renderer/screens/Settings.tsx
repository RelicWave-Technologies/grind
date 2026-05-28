import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MonitorCheck, Power, FolderOpen, CheckCircle2, AlertCircle } from 'lucide-react';

export default function Settings() {
  const qc = useQueryClient();
  const info = useQuery({ queryKey: ['settings'], queryFn: () => window.agent.settings.get(), refetchInterval: 4000 });
  const perm = useQuery({ queryKey: ['screenPerm'], queryFn: () => window.agent.permissions.screen(), refetchInterval: 4000 });

  const setLogin = useMutation({
    mutationFn: (v: boolean) => window.agent.settings.setLaunchAtLogin(v),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['settings'] }),
  });

  const state = perm.data?.state ?? 'ok';
  const ok = state === 'ok';
  const sub =
    state === 'ok'
      ? { ok: true, text: 'Granted' }
      : state === 'needs-restart'
        ? { ok: false, text: 'Restart needed for capture to take effect' }
        : { ok: false, text: 'Required for screenshots' };

  return (
    <>
      <div className="toolbar"><span className="h1 no-drag">Settings</span></div>
      <div className="content-scroll">
        <div className="content-narrow">
          {/* Permissions */}
          <div className="section-head"><span className="section-title">Permissions</span></div>
          <div className="set-card">
            <div className="set-row">
              <span className="set-ic" style={{ background: ok ? 'var(--c-green)' : 'var(--c-orange)' }}>
                <MonitorCheck size={17} strokeWidth={2} />
              </span>
              <div className="set-main">
                <div className="set-title">Screen Recording</div>
                <div className="set-sub">
                  {sub.ok ? (
                    <span className="set-ok"><CheckCircle2 size={13} /> {sub.text}</span>
                  ) : (
                    <span className="set-warn"><AlertCircle size={13} /> {sub.text}</span>
                  )}
                </div>
              </div>
              {state === 'needs-restart' ? (
                <button className="btn btn-prominent no-drag" onClick={() => window.agent.app.relaunch()}>
                  Restart Grind
                </button>
              ) : !ok ? (
                <button className="btn no-drag" onClick={() => window.agent.settings.openScreenPrefs()}>
                  Open System Settings
                </button>
              ) : null}
            </div>
          </div>

          {/* General */}
          <div className="section-head"><span className="section-title">General</span></div>
          <div className="set-card">
            <div className="set-row">
              <span className="set-ic" style={{ background: 'var(--violet)' }}><Power size={17} strokeWidth={2} /></span>
              <div className="set-main">
                <div className="set-title">Launch at login</div>
                <div className="set-sub secondary">Start Grind automatically and track from the moment you log in.</div>
              </div>
              <button
                role="switch"
                aria-checked={!!info.data?.launchAtLogin}
                className={`toggle no-drag${info.data?.launchAtLogin ? ' on' : ''}`}
                onClick={() => setLogin.mutate(!info.data?.launchAtLogin)}
                disabled={setLogin.isPending}
              >
                <span className="toggle-knob" />
              </button>
            </div>
            <div className="set-row">
              <span className="set-ic" style={{ background: 'var(--c-slate)' }}><FolderOpen size={17} strokeWidth={2} /></span>
              <div className="set-main">
                <div className="set-title">Local data</div>
                <div className="set-sub secondary">Screenshots and the offline queue are stored on this device.</div>
              </div>
              <button className="btn no-drag" onClick={() => window.agent.settings.openDataFolder()}>Open folder</button>
            </div>
          </div>

          {/* About */}
          <div className="section-head"><span className="section-title">About</span></div>
          <div className="set-card">
            <div className="set-row">
              <div className="set-main">
                <div className="set-title">Grind</div>
                <div className="set-sub secondary">Version {info.data?.version ?? '—'} · {info.data?.platform ?? ''}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
