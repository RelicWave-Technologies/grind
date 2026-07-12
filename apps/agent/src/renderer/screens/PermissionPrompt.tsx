import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, Keyboard, Lock, MonitorCheck, RotateCcw, X } from 'lucide-react';
import type { CapabilityState } from '../../shared/tracking';
import type { AttentionPrompt } from '../../shared/attention';
import timoMascot from '../assets/timo-mascot.svg';

function actionFor(state: CapabilityState): 'enable' | 'settings' | 'restart' | null {
  if (state === 'NEEDS_GRANT') return 'enable';
  if (state === 'NEEDS_SETTINGS') return 'settings';
  if (state === 'NEEDS_RESTART' || state === 'FAILED') return 'restart';
  return null;
}

function isReady(state: CapabilityState): boolean {
  return state === 'READY' || state === 'NOT_REQUIRED';
}

function statusText(state: CapabilityState): string {
  if (state === 'READY' || state === 'NOT_REQUIRED') return 'Ready';
  if (state === 'NEEDS_GRANT') return 'Permission required';
  if (state === 'NEEDS_SETTINGS') return 'Enable in System Settings';
  if (state === 'NEEDS_RESTART') return 'Restart Timo to apply';
  return 'Permission service needs restart';
}

function StatusLine({ state }: { state: CapabilityState }) {
  return isReady(state) ? (
    <div className="set-ok"><CheckCircle2 size={13} /> {statusText(state)}</div>
  ) : (
    <div className="set-warn"><AlertCircle size={13} /> {statusText(state)}</div>
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
  const ready = state?.ready === true;
  const busy = requestScreen.isPending || requestAccessibility.isPending || retry.isPending;

  const yieldToSettings = async (): Promise<boolean> => {
    const result = await window.agent.attention.yieldToSystemSettings(prompt.promptId);
    return result.ok;
  };
  const runScreenAction = async () => {
    if (screenAction === 'enable') {
      if (await yieldToSettings()) requestScreen.mutate();
    } else if (screenAction === 'settings') {
      if (await yieldToSettings()) await window.agent.settings.openScreenPrefs();
    } else if (screenAction === 'restart') {
      void window.agent.app.relaunch();
    }
  };
  const runAccessibilityAction = async () => {
    if (accessibilityAction === 'enable' || accessibilityAction === 'settings') {
      if (await yieldToSettings()) requestAccessibility.mutate();
    } else if (accessibilityAction === 'restart') {
      void window.agent.app.relaunch();
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
            <StatusLine state={screenState} />
          </div>
          {screenAction ? (
            <button className="btn no-drag" onClick={runScreenAction} disabled={busy}>
              {screenAction === 'enable' ? 'Enable' : screenAction === 'settings' ? 'Open Settings' : <><RotateCcw size={14} /> Restart</>}
            </button>
          ) : null}
        </div>

        <div className="perm-row">
          <span className={`perm-icon${isReady(accessibilityState) ? ' is-ready' : ''}`}>
            <Keyboard size={20} strokeWidth={2} />
          </span>
          <div className="perm-main">
            <div className="set-title">Accessibility</div>
            <StatusLine state={accessibilityState} />
          </div>
          {accessibilityAction ? (
            <button className="btn no-drag" onClick={runAccessibilityAction} disabled={busy}>
              {accessibilityAction === 'enable' ? 'Enable' : accessibilityAction === 'settings' ? 'Open Settings' : <><RotateCcw size={14} /> Restart</>}
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
