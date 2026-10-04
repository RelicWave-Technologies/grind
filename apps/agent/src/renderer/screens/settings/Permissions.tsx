import { useQuery } from '@tanstack/react-query';
import { MonitorCheck, CheckCircle2, AlertCircle, Keyboard } from 'lucide-react';

/** macOS Screen Recording and Accessibility, each with the one action that fixes it. */
export default function PermissionsSection() {
  const permissions = useQuery({ queryKey: ['trackingReadiness'], queryFn: () => window.agent.permissions.readiness(), refetchInterval: 4000 });
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

  return (
    <div className="set-card">
      <div className="set-row">
        <span className="set-ic">
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
        <span className="set-ic">
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
  );
}
