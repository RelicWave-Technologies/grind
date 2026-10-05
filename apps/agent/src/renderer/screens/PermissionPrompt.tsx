import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, Keyboard, Lock, MonitorCheck, X } from 'lucide-react';
import type { CapabilityState } from '../../shared/tracking';
import type { AttentionPrompt } from '../../shared/attention';
import timoMascot from '../assets/timo-mascot.svg';

import {
  actionFor,
  actionLabel,
  isReady,
  offersRestart,
  RESTART_LABEL,
  statusText,
  type Capability,
  type PermissionAction,
} from '../lib/permissionUi';

function StatusLine({ state, capability }: { state: CapabilityState; capability: Capability }) {
  return isReady(state) ? (
    <div className="set-ok"><CheckCircle2 size={13} /> {statusText(state, capability)}</div>
  ) : (
    <div className="set-warn"><AlertCircle size={13} /> {statusText(state, capability)}</div>
  );
}

/** The secondary links under a row: Open Settings beside Check again, and
 *  Restart Timo once it is the remaining fallback. */
function RowLinks({ settings, restart, onSettings, disabled }: {
  settings: boolean;
  restart: boolean;
  onSettings: () => void;
  disabled: boolean;
}) {
  if (!settings && !restart) return null;
  return (
    <div className="set-sub">
      {settings ? (
        <button className="link-btn no-drag" onClick={onSettings} disabled={disabled}>
          {actionLabel('settings')}
        </button>
      ) : null}
      {settings && restart ? ' · ' : null}
      {restart ? (
        <button className="link-btn no-drag" onClick={() => void window.agent.app.relaunch()} disabled={disabled}>
          {RESTART_LABEL}
        </button>
      ) : null}
    </div>
  );
}

export default function PermissionPrompt({ prompt }: { prompt: Extract<AttentionPrompt, { kind: 'PERMISSION' }> }) {
  const qc = useQueryClient();
  const readiness = useQuery({
    queryKey: ['trackingReadiness'],
    queryFn: () => window.agent.permissions.readiness(),
    refetchInterval: 1000,
    staleTime: 0,
  });
  const requestScreen = useMutation({
    mutationFn: () => window.agent.permissions.requestScreen(),
    onSuccess: (next) => qc.setQueryData(['trackingReadiness'], next),
  });
  // Restart is only ever a fallback: after Check again left a FAILED verdict
  // standing, or after a trip to System Settings left the screen not granted.
  const [checkedAgain, setCheckedAgain] = useState(false);
  const [returnedFromScreenSettings, setReturnedFromScreenSettings] = useState(false);
  const recheck = useMutation({
    mutationFn: () => window.agent.permissions.recheck(),
    onSuccess: (next) => {
      qc.setQueryData(['trackingReadiness'], next);
      setCheckedAgain(true);
    },
  });
  const requestAccessibility = useMutation({
    mutationFn: () => window.agent.permissions.requestAccessibility(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['trackingReadiness'] }),
  });
  const retry = useMutation({
    mutationFn: () => window.agent.attention.resolve(prompt.promptId, 'PERMISSION_RETRY'),
  });

  const state = readiness.data;
  const screenState = state?.screenRecording ?? 'NEEDS_GRANT';
  const accessibilityState = state?.accessibility ?? 'NEEDS_GRANT';
  const screenAction = actionFor(screenState);
  const accessibilityAction = actionFor(accessibilityState);
  const screenRestart = offersRestart(screenState, 'screen', {
    checkedAgain,
    returnedFromSettings: returnedFromScreenSettings,
  });
  const accessibilityRestart = offersRestart(accessibilityState, 'accessibility', {
    checkedAgain,
    returnedFromSettings: false,
  });
  const ready = state?.ready === true;
  const busy = requestScreen.isPending || requestAccessibility.isPending || recheck.isPending || retry.isPending;

  const yieldToSettings = async (): Promise<boolean> => {
    const result = await window.agent.attention.yieldToSystemSettings(prompt.promptId);
    return result.ok;
  };
  const runScreenAction = async (action: PermissionAction) => {
    if (action === 'enable') {
      if (await yieldToSettings()) {
        setReturnedFromScreenSettings(true);
        requestScreen.mutate();
      }
    } else if (action === 'settings') {
      if (await yieldToSettings()) {
        setReturnedFromScreenSettings(true);
        await window.agent.settings.openScreenPrefs();
      }
    } else if (action === 'check-again') {
      recheck.mutate();
    }
  };
  const runAccessibilityAction = async (action: PermissionAction) => {
    if (action === 'enable' || action === 'settings') {
      if (await yieldToSettings()) requestAccessibility.mutate();
    } else if (action === 'check-again') {
      recheck.mutate();
    }
  };

  return (
    <div className="perm-shell drag">
      <header className="perm-head">
        <span className="brand-mark perm-mascot"><img src={timoMascot} alt="" /></span>
        <div className="perm-title-wrap">
          <div className="h2">Permissions needed</div>
          <div className="callout secondary">Timo needs both services ready before tracking can start.</div>
        </div>
        <button className="perm-close no-drag" title="Close" onClick={() => window.agent.attention.resolve(prompt.promptId, 'PERMISSION_CLOSE')}>
          <X size={15} strokeWidth={2.2} />
        </button>
      </header>

      <div className="perm-list">
        <div className="perm-row">
          <span className={`perm-icon${isReady(screenState) ? ' is-ready' : ''}`}>
            <MonitorCheck size={20} strokeWidth={2} />
          </span>
          <div className="perm-main">
            <div className="set-title">Screen Recording</div>
            <StatusLine state={screenState} capability="screen" />
            <RowLinks
              settings={screenAction === 'check-again'}
              restart={screenRestart}
              onSettings={() => runScreenAction('settings')}
              disabled={busy}
            />
          </div>
          {screenAction ? (
            <button className="btn no-drag" onClick={() => runScreenAction(screenAction)} disabled={busy}>
              {actionLabel(screenAction)}
            </button>
          ) : null}
        </div>

        <div className="perm-row">
          <span className={`perm-icon${isReady(accessibilityState) ? ' is-ready' : ''}`}>
            <Keyboard size={20} strokeWidth={2} />
          </span>
          <div className="perm-main">
            <div className="set-title">Accessibility</div>
            <StatusLine state={accessibilityState} capability="accessibility" />
            <RowLinks
              settings={accessibilityAction === 'check-again'}
              restart={accessibilityRestart}
              onSettings={() => runAccessibilityAction('settings')}
              disabled={busy}
            />
          </div>
          {accessibilityAction ? (
            <button className="btn no-drag" onClick={() => runAccessibilityAction(accessibilityAction)} disabled={busy}>
              {actionLabel(accessibilityAction)}
            </button>
          ) : null}
        </div>
      </div>

      <footer className="perm-actions">
        {ready && prompt.intent !== 'SETUP' ? (
          <button className="btn btn-prominent btn-lg btn-block no-drag" onClick={() => retry.mutate()} disabled={busy}>
            {prompt.intent === 'RESUME_ENTRY' ? 'Resume tracking' : 'Start tracking'}
          </button>
        ) : ready ? (
          <button className="btn btn-prominent btn-lg btn-block no-drag" onClick={() => window.agent.attention.resolve(prompt.promptId, 'PERMISSION_CLOSE')}>
            Done
          </button>
        ) : (
          <div className="perm-gate-note">
            <Lock size={14} strokeWidth={2} />
            <span>Tracking stays paused until both permissions are ready.</span>
          </div>
        )}
      </footer>
    </div>
  );
}
