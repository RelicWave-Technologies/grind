import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Power, CheckCircle2, AlertCircle, PictureInPicture2 } from 'lucide-react';

type SettingsInfo = Awaited<ReturnType<typeof window.agent.settings.get>>;

/** Launch at login and the floating timer bar. */
export default function GeneralSection() {
  const qc = useQueryClient();
  const info = useQuery({ queryKey: ['settings'], queryFn: () => window.agent.settings.get(), refetchInterval: 4000 });
  const repairLogin = useMutation({
    mutationFn: () => window.agent.settings.repairLaunchAtLogin(),
    onSuccess: (launchAtLogin) => {
      qc.setQueryData<SettingsInfo | undefined>(
        ['settings'],
        (current) => current ? { ...current, launchAtLogin } : current,
      );
      if (launchAtLogin.remediation === 'OPEN_LOGIN_ITEMS' || launchAtLogin.remediation === 'OPEN_STARTUP_APPS') {
        void window.agent.settings.openStartupPrefs();
      }
      void qc.invalidateQueries({ queryKey: ['settings'] });
    },
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

  const inspectedLaunch = info.data?.launchAtLogin;
  const attemptedLaunch = repairLogin.data;
  const launch = attemptedLaunch && !attemptedLaunch.ready && inspectedLaunch?.state !== 'READY'
    ? attemptedLaunch
    : inspectedLaunch;
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
    <div className="set-card">
      <div className="set-row">
        <span className="set-ic"><Power size={17} strokeWidth={2} /></span>
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
        <span className="set-ic"><PictureInPicture2 size={17} strokeWidth={2} /></span>
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
  );
}
