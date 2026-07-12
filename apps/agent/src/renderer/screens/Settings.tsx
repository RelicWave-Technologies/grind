import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MonitorCheck, Power, CheckCircle2, AlertCircle, Keyboard, PictureInPicture2, RefreshCw, DownloadCloud } from 'lucide-react';
import larkIcon from '../assets/lark.svg';
import { settingsUpdateSubtitle, updateAction, updatePercent } from '../lib/updateUi';

export default function Settings() {
  const qc = useQueryClient();
  const info = useQuery({ queryKey: ['settings'], queryFn: () => window.agent.settings.get(), refetchInterval: 4000 });
  const permissions = useQuery({ queryKey: ['trackingReadiness'], queryFn: () => window.agent.permissions.readiness(), refetchInterval: 4000 });
  const lark = useQuery({ queryKey: ['larkStatus'], queryFn: () => window.agent.lark.status(), refetchInterval: 4000 });
  const updates = useQuery({ queryKey: ['updates'], queryFn: () => window.agent.updates.status(), refetchInterval: 60_000 });

  const repairLogin = useMutation({
    mutationFn: () => window.agent.settings.repairLaunchAtLogin(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['settings'] }),
  });
  const moveToApplications = useMutation({
    mutationFn: () => window.agent.settings.moveToApplications(),
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

  useEffect(() => {
    let alive = true;
    void window.agent.updates.checkQuietly()
      .then((s) => {
        if (alive) qc.setQueryData(['updates'], s);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
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

  const screenState = permissions.data?.screenRecording ?? 'NEEDS_GRANT';
  const screenReady = screenState === 'READY' || screenState === 'NOT_REQUIRED';
  const screenText = screenReady
    ? 'Ready'
    : screenState === 'NEEDS_GRANT'
      ? 'Required for screenshots'
      : screenState === 'NEEDS_SETTINGS'
        ? 'Enable in System Settings'
        : 'Restart needed for capture to take effect';
  const accessibilityState = permissions.data?.accessibility ?? 'NEEDS_GRANT';
  const accessibilityReady = accessibilityState === 'READY' || accessibilityState === 'NOT_REQUIRED';
  const accessibilityText = accessibilityReady
    ? 'Ready — counts while the timer runs'
    : accessibilityState === 'NEEDS_GRANT'
      ? 'Needed to count keystrokes & mouse'
      : accessibilityState === 'NEEDS_SETTINGS'
        ? 'Enable in System Settings'
        : 'Restart Timo to start activity tracking';
  const u = updates.data;
  const updateBusy = u?.phase === 'checking' || u?.phase === 'downloading' || u?.phase === 'installing' || checkUpdates.isPending;
  const updatePercentValue = updatePercent(u);
  const updateSub = settingsUpdateSubtitle(u);
  const updateButton = updateAction(u, updateBusy || installUpdate.isPending);
  const launch = info.data?.launchAtLogin;
  const launchText = !launch
    ? 'Checking startup status...'
    : launch.state === 'READY'
      ? 'Starts automatically when you sign in'
      : launch.state === 'NEEDS_INSTALL'
        ? 'Move Timo to Applications to enable startup'
        : launch.state === 'NEEDS_APPROVAL'
          ? 'Approve Timo in Login Items'
          : launch.state === 'NEEDS_REGISTRATION'
            ? 'Startup registration is missing'
            : launch.state === 'NEEDS_REPAIR'
              ? 'Startup item is disabled or points to the wrong app'
              : launch.state === 'BLOCKED'
                ? 'Startup is blocked by system settings'
                : 'Unavailable in dev mode';
  const moveError = moveToApplications.data?.ok === false
    ? moveToApplications.data.reason === 'TRACKING_ACTIVE'
      ? 'Stop tracking before moving Timo.'
      : moveToApplications.data.reason === 'MOVE_FAILED'
        ? 'Timo could not be moved. Check Applications folder access.'
        : null
    : null;
  const launchOk = launch?.ready === true;
  const launchWarn = !!launch && !launch.ready && launch.state !== 'UNAVAILABLE';

  return (
    <>
      <div className="toolbar"><span className="h1 no-drag">Settings</span></div>
      <div className="content-scroll">
        <div className="content-narrow">
          {/* Permissions */}
          <div className="section-head"><span className="section-title">Permissions</span></div>
          <div className="set-card">
            <div className="set-row">
              <span className="set-ic" style={{ background: screenReady ? 'var(--c-green-bg)' : 'var(--c-orange-bg)' }}>
                <MonitorCheck size={17} strokeWidth={2} />
              </span>
              <div className="set-main">
                <div className="set-title">Screen Recording</div>
                <div className="set-sub">
                  {screenReady ? (
                    <span className="set-ok"><CheckCircle2 size={13} /> {screenText}</span>
                  ) : (
                    <span className="set-warn"><AlertCircle size={13} /> {screenText}</span>
                  )}
                </div>
              </div>
              {screenState === 'NEEDS_RESTART' || screenState === 'FAILED' ? (
                <button className="btn btn-prominent no-drag" onClick={() => window.agent.app.relaunch()}>
                  Restart Timo
                </button>
              ) : screenState === 'NEEDS_GRANT' ? (
                <button className="btn no-drag" onClick={() => window.agent.permissions.requestScreen()}>
                  Enable
                </button>
              ) : !screenReady ? (
                <button className="btn no-drag" onClick={() => window.agent.settings.openScreenPrefs()}>
                  Open System Settings
                </button>
              ) : null}
            </div>

            <div className="set-row">
              <span className="set-ic" style={{ background: accessibilityReady ? 'var(--c-green-bg)' : 'var(--c-orange-bg)' }}>
                <Keyboard size={17} strokeWidth={2} />
              </span>
              <div className="set-main">
                <div className="set-title">Accessibility</div>
                <div className="set-sub">
                  {accessibilityReady ? (
                    <span className="set-ok"><CheckCircle2 size={13} /> {accessibilityText}</span>
                  ) : (
                    <span className="set-warn"><AlertCircle size={13} /> {accessibilityText}</span>
                  )}
                </div>
              </div>
              {accessibilityState === 'NEEDS_RESTART' || accessibilityState === 'FAILED' ? (
                <button className="btn btn-prominent no-drag" onClick={() => window.agent.app.relaunch()}>
                  Restart Timo
                </button>
              ) : !accessibilityReady ? (
                <button className="btn no-drag" onClick={() => window.agent.permissions.requestAccessibility()}>
                  Enable
                </button>
              ) : null}
            </div>
          </div>

          {/* Integrations */}
          <div className="section-head"><span className="section-title">Integrations</span></div>
          <div className="set-card">
            <div className="set-row">
              <span className="set-ic" style={{ background: larkConnected ? 'var(--c-green-bg)' : 'var(--c-violet-bg)' }}>
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

          {/* General */}
          <div className="section-head"><span className="section-title">General</span></div>
          <div className="set-card">
            <div className="set-row">
              <span className="set-ic" style={{ background: launchOk ? 'var(--c-green-bg)' : launchWarn ? 'var(--c-orange-bg)' : 'var(--c-violet-bg)' }}><Power size={17} strokeWidth={2} /></span>
              <div className="set-main">
                <div className="set-title">Launch at login</div>
                <div className="set-sub">
                  {launchOk ? (
                    <span className="set-ok"><CheckCircle2 size={13} /> {launchText}</span>
                  ) : launchWarn ? (
                    <span className="set-warn"><AlertCircle size={13} /> {moveError ?? launchText}</span>
                  ) : (
                    <span className="secondary">{launchText}</span>
                  )}
                </div>
              </div>
              {launch?.remediation === 'MOVE_TO_APPLICATIONS' ? (
                <button
                  className="btn btn-prominent no-drag"
                  onClick={() => moveToApplications.mutate()}
                  disabled={moveToApplications.isPending}
                >
                  Move to Applications
                </button>
              ) : launch?.remediation === 'OPEN_LOGIN_ITEMS' || launch?.remediation === 'OPEN_STARTUP_APPS' ? (
                <button className="btn no-drag" onClick={() => window.agent.settings.openStartupPrefs()}>
                  {launch.remediation === 'OPEN_LOGIN_ITEMS' ? 'Open Login Items' : 'Open Startup Apps'}
                </button>
              ) : launch?.canRepair ? (
                <button
                  className="btn btn-prominent no-drag"
                  onClick={() => repairLogin.mutate()}
                  disabled={repairLogin.isPending}
                >
                  Repair
                </button>
              ) : null}
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
              <span className="set-ic" style={{ background: u?.phase === 'ready' || u?.phase === 'installing' ? 'var(--c-green-bg)' : 'var(--c-violet-bg)' }}>
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
        </div>
      </div>
    </>
  );
}
