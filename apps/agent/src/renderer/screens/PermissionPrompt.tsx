import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, Keyboard, Lock, MonitorCheck, RotateCcw, X } from 'lucide-react';
import type { CapabilityState } from '../../shared/tracking';
import type { AttentionPrompt } from '../../shared/attention';
import timoMascot from '../assets/timo-mascot.svg';

import { actionFor, actionLabel, isReady, statusText, type Capability, type PermissionAction } from '../lib/permissionUi';

function StatusLine({ state, capability, restartDidNotHelp }: { state: CapabilityState; capability: Capability; restartDidNotHelp: boolean }) {
  return isReady(state) ? (
    <div className="set-ok"><CheckCircle2 size={13} /> {statusText(state, capability)}</div>
  ) : (
    <div className="set-warn"><AlertCircle size={13} /> {statusText(state, capability, restartDidNotHelp)}</div>
  );
}

function ActionButton({ action, onClick, disabled }: { action: PermissionAction; onClick: () => void; disabled: boolean }) {
  return (
    <button className="btn no-drag" onClick={onClick} disabled={disabled}>
      {action === 'restart' ? <><RotateCcw size={14} /> {actionLabel(action)}</> : actionLabel(action)}
    </button>
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
  const recheck = useMutation({
    mutationFn: () => window.agent.permissions.recheck(),
    onSuccess: (next) => qc.setQueryData(['trackingReadiness'], next),
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
  const screenRestartDidNotHelp = state?.restartDidNotHelp?.includes('SCREEN_RECORDING') ?? false;
  const accessibilityRestartDidNotHelp = state?.restartDidNotHelp?.includes('ACCESSIBILITY') ?? false;
  const screenAction = actionFor(screenState, 'screen', screenRestartDidNotHelp);
  const accessibilityAction = actionFor(accessibilityState, 'accessibility', accessibilityRestartDidNotHelp);
  const ready = state?.ready === true;
  const busy = requestScreen.isPending || requestAccessibility.isPending || recheck.isPending || retry.isPending;

  const yieldToSettings = async (): Promise<boolean> => {
    const result = await window.agent.attention.yieldToSystemSettings(prompt.promptId);
    return result.ok;
  };
  const runScreenAction = async (action: PermissionAction) => {
    if (action === 'enable') {
      if (await yieldToSettings()) requestScreen.mutate();
    } else if (action === 'settings') {
      if (await yieldToSettings()) await window.agent.settings.openScreenPrefs();
    } else if (action === 'restart') {
      void window.agent.app.relaunch();
    } else if (action === 'check-again') {
      recheck.mutate();
    }
  };
  const runAccessibilityAction = async (action: PermissionAction) => {
    if (action === 'enable' || action === 'settings') {
      if (await yieldToSettings()) requestAccessibility.mutate();
    } else if (action === 'input-monitoring') {
      if (await yieldToSettings()) await window.agent.settings.openInputMonitoringPrefs();
    } else if (action === 'restart') {
      void window.agent.app.relaunch();
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
            <StatusLine state={screenState} capability="screen" restartDidNotHelp={screenRestartDidNotHelp} />
            {screenAction === 'check-again' ? (
              <div className="set-sub">
                <button className="link-btn no-drag" onClick={() => runScreenAction('settings')} disabled={busy}>
                  {actionLabel('settings')}
                </button>
              </div>
            ) : null}
          </div>
          {screenAction ? (
            <ActionButton action={screenAction} onClick={() => runScreenAction(screenAction)} disabled={busy} />
          ) : null}
        </div>

        <div className="perm-row">
          <span className={`perm-icon${isReady(accessibilityState) ? ' is-ready' : ''}`}>
            <Keyboard size={20} strokeWidth={2} />
          </span>
          <div className="perm-main">
            <div className="set-title">Accessibility</div>
            <StatusLine state={accessibilityState} capability="accessibility" restartDidNotHelp={accessibilityRestartDidNotHelp} />
            {accessibilityAction === 'check-again' ? (
              <div className="set-sub">
                <button className="link-btn no-drag" onClick={() => runAccessibilityAction('settings')} disabled={busy}>
                  {actionLabel('settings')}
                </button>
              </div>
            ) : null}
          </div>
          {accessibilityAction ? (
            <ActionButton action={accessibilityAction} onClick={() => runAccessibilityAction(accessibilityAction)} disabled={busy} />
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
