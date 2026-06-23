import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MonitorCheck, Power, CheckCircle2, AlertCircle, Link2, Keyboard, PictureInPicture2, RefreshCw, DownloadCloud } from 'lucide-react';
import { settingsUpdateSubtitle, updateAction, updatePercent } from '../lib/updateUi';

export default function Settings() {
  const qc = useQueryClient();
  const info = useQuery({ queryKey: ['settings'], queryFn: () => window.agent.settings.get(), refetchInterval: 4000 });
  const perm = useQuery({ queryKey: ['screenPerm'], queryFn: () => window.agent.permissions.screen(), refetchInterval: 4000 });
  const a11y = useQuery({ queryKey: ['a11yPerm'], queryFn: () => window.agent.permissions.accessibility(), refetchInterval: 4000 });
  const lark = useQuery({ queryKey: ['larkStatus'], queryFn: () => window.agent.lark.status(), refetchInterval: 4000 });
  const updates = useQuery({ queryKey: ['updates'], queryFn: () => window.agent.updates.status(), refetchInterval: 60_000 });

  const setLogin = useMutation({
    mutationFn: (v: boolean) => window.agent.settings.setLaunchAtLogin(v),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['settings'] }),
  });

  const setFloatingBar = useMutation({
    mutationFn: (v: boolean) => window.agent.settings.setFloatingBarVisible(v),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['settings'] }),
  });
  const resetFloatingBar = useMutation({
    mutationFn: () => window.agent.settings.resetFloatingBarPosition(),
  });

  const connectLark = useMutation({
    mutationFn: () => window.agent.lark.connect(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['larkStatus'] }),
  });
  const disconnectLark = useMutation({
    mutationFn: () => window.agent.lark.disconnect(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['larkStatus'] }),
  });
  const checkUpdates = useMutation({
    mutationFn: () => window.agent.updates.checkNow(),
    onSuccess: (s) => qc.setQueryData(['updates'], s),
  });
  const installUpdate = useMutation({
    mutationFn: () => window.agent.updates.installNow(),
    onSuccess: (s) => qc.setQueryData(['updates'], s),
  });

  useEffect(() => {
    return window.agent.updates.onStatusChange((s) => {
      qc.setQueryData(['updates'], s);
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
  const u = updates.data;
  const updateBusy = u?.phase === 'checking' || u?.phase === 'downloading' || checkUpdates.isPending;
  const updatePercentValue = updatePercent(u);
  const updateSub = settingsUpdateSubtitle(u);
  const updateButton = updateAction(u, updateBusy || installUpdate.isPending);

  return (
    <>
      <div className="toolbar"><span className="h1 no-drag">Settings</span></div>
      <div className="content-scroll">
        <div className="content-narrow">
          {/* Permissions */}
          <div className="section-head"><span className="section-title">Permissions</span></div>
          <div className="set-card">
            <div className="set-row">
              <span className="set-ic" style={{ background: ok ? 'var(--c-green-bg)' : 'var(--c-orange-bg)' }}>
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
              <span className="set-ic" style={{ background: aCapturing ? 'var(--c-green-bg)' : 'var(--c-orange-bg)' }}>
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
              <span className="set-ic" style={{ background: larkConnected ? 'var(--c-green-bg)' : 'var(--c-violet-bg)' }}>
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
              <span className="set-ic" style={{ background: 'var(--c-violet-bg)' }}><Power size={17} strokeWidth={2} /></span>
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
              <span className="set-ic" style={{ background: 'var(--c-blue-bg)' }}><PictureInPicture2 size={17} strokeWidth={2} /></span>
              <div className="set-main">
                <div className="set-title">Floating timer bar</div>
                <div className="set-sub secondary">
                  Show the always-on-top mini bar while tracking. Drag it anywhere — it stays put.
                  {info.data?.floatingBarVisible && (
                    <>
                      {' '}
                      <button
                        className="link-btn no-drag"
                        onClick={() => resetFloatingBar.mutate()}
                        disabled={resetFloatingBar.isPending}
                      >
                        Reset position
                      </button>
                    </>
                  )}
                </div>
              </div>
              <button
                role="switch"
                aria-checked={!!info.data?.floatingBarVisible}
                className={`toggle no-drag${info.data?.floatingBarVisible ? ' on' : ''}`}
                onClick={() => setFloatingBar.mutate(!info.data?.floatingBarVisible)}
                disabled={setFloatingBar.isPending}
              >
                <span className="toggle-knob" />
              </button>
            </div>
          </div>

          {/* About */}
          <div className="section-head"><span className="section-title">About</span></div>
          <div className="set-card">
            <div className="set-row">
              <span className="set-ic" style={{ background: u?.phase === 'ready' ? 'var(--c-green-bg)' : 'var(--c-violet-bg)' }}>
                {u?.phase === 'ready' ? <DownloadCloud size={17} strokeWidth={2} /> : <RefreshCw size={17} strokeWidth={2} />}
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
