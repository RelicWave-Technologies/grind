import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MonitorCheck, Power, FolderOpen, CheckCircle2, AlertCircle, Link2, Keyboard } from 'lucide-react';

export default function Settings() {
  const qc = useQueryClient();
  const info = useQuery({ queryKey: ['settings'], queryFn: () => window.agent.settings.get(), refetchInterval: 4000 });
  const perm = useQuery({ queryKey: ['screenPerm'], queryFn: () => window.agent.permissions.screen(), refetchInterval: 4000 });
  const a11y = useQuery({ queryKey: ['a11yPerm'], queryFn: () => window.agent.permissions.accessibility(), refetchInterval: 4000 });
  const lark = useQuery({ queryKey: ['larkStatus'], queryFn: () => window.agent.lark.status(), refetchInterval: 4000 });

  const setLogin = useMutation({
    mutationFn: (v: boolean) => window.agent.settings.setLaunchAtLogin(v),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['settings'] }),
  });

  const connectLark = useMutation({
    mutationFn: () => window.agent.lark.connect(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['larkStatus'] }),
  });
  const disconnectLark = useMutation({
    mutationFn: () => window.agent.lark.disconnect(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['larkStatus'] }),
  });

  const l = lark.data;
  const larkConnected = !!l?.connected;
  const larkReauth = !!l?.reauthRequired;
  const larkSub = !l?.configured
    ? { ok: false, text: 'Not configured by your workspace' }
    : larkReauth
      ? { ok: false, text: 'Reconnect needed — your Lark session expired' }
      : larkConnected
        ? { ok: true, text: 'Connected' }
        : { ok: false, text: 'Connect to attribute time to Lark tasks' };

  const state = perm.data?.state ?? 'ok';
  const ok = state === 'ok';
  const sub =
    state === 'ok'
      ? { ok: true, text: 'Granted' }
      : state === 'needs-restart'
        ? { ok: false, text: 'Restart needed for capture to take effect' }
        : { ok: false, text: 'Required for screenshots' };

  const aTrusted = !!a11y.data?.trusted;
  const aCapturing = !!a11y.data?.capturing;

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

            <div className="set-row">
              <span className="set-ic" style={{ background: aCapturing ? 'var(--c-green)' : 'var(--c-orange)' }}>
                <Keyboard size={17} strokeWidth={2} />
              </span>
              <div className="set-main">
                <div className="set-title">Accessibility</div>
                <div className="set-sub">
                  {aCapturing ? (
                    <span className="set-ok"><CheckCircle2 size={13} /> Tracking keyboard &amp; mouse activity</span>
                  ) : aTrusted ? (
                    <span className="set-warn"><AlertCircle size={13} /> Granted — restart to start tracking</span>
                  ) : (
                    <span className="set-warn"><AlertCircle size={13} /> Needed to count keystrokes &amp; mouse</span>
                  )}
                </div>
              </div>
              {aCapturing ? null : aTrusted ? (
                <button className="btn btn-prominent no-drag" onClick={() => window.agent.app.relaunch()}>
                  Restart Grind
                </button>
              ) : (
                <button className="btn no-drag" onClick={() => window.agent.permissions.requestAccessibility()}>
                  Enable
                </button>
              )}
            </div>
          </div>

          {/* Integrations */}
          <div className="section-head"><span className="section-title">Integrations</span></div>
          <div className="set-card">
            <div className="set-row">
              <span className="set-ic" style={{ background: larkConnected ? 'var(--c-green)' : 'var(--violet)' }}>
                <Link2 size={17} strokeWidth={2} />
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
