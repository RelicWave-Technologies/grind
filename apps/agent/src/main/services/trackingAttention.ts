import { ulid } from 'ulid';
import type { AttentionPrompt, PermissionIntent } from '../../shared/attention';
import { attentionPresenter } from '../attentionWindow';

export interface AttentionPresenter {
  show(prompt: Exclude<AttentionPrompt, { kind: 'NONE' }>): void;
  hide(): void;
  yieldToSystemSettings(prompt: Extract<AttentionPrompt, { kind: 'PERMISSION' }>): void;
  reassert(): void;
}

interface TrackingAttentionDeps {
  id: () => string;
  presenter: AttentionPresenter;
}

export function createTrackingAttentionCoordinator(deps: TrackingAttentionDeps) {
  let active: AttentionPrompt = { kind: 'NONE' };

  function show(next: Exclude<AttentionPrompt, { kind: 'NONE' }>): AttentionPrompt {
    active = next;
    deps.presenter.show(next);
    return active;
  }

  function requestIdle(idleStartedAt: number): boolean {
    if (active.kind !== 'NONE') return false;
    show({ kind: 'IDLE', promptId: deps.id(), idleStartedAt });
    return true;
  }

  function beginMachineAway(): void {
    if (active.kind === 'IDLE' || active.kind === 'AWAY') {
      active = { kind: 'NONE' };
      deps.presenter.hide();
    }
  }

  function requestAway(info: { larkTaskGuid: string | null; stoppedAt: number; reason: 'suspend' | 'lock' }): boolean {
    if (active.kind === 'PERMISSION') return false;
    show({ kind: 'AWAY', promptId: deps.id(), ...info });
    return true;
  }

  function requestPermission(intent: PermissionIntent): AttentionPrompt {
    const promptId = active.kind === 'PERMISSION' ? active.promptId : deps.id();
    return show({ kind: 'PERMISSION', promptId, intent, presentation: 'FRONT' });
  }

  function yieldPermissionToSystemSettings(promptId: string): boolean {
    if (active.kind !== 'PERMISSION' || active.promptId !== promptId) return false;
    active = { ...active, presentation: 'YIELDED_TO_SETTINGS' };
    deps.presenter.yieldToSystemSettings(active);
    return true;
  }

  function restoreActive(): boolean {
    if (active.kind === 'NONE') return false;
    if (active.kind === 'PERMISSION' && active.presentation === 'YIELDED_TO_SETTINGS') {
      active = { ...active, presentation: 'FRONT' };
      deps.presenter.show(active);
      return true;
    }
    deps.presenter.reassert();
    return true;
  }

  function clear(promptId?: string): boolean {
    if (active.kind === 'NONE') return false;
    if (promptId && active.promptId !== promptId) return false;
    active = { kind: 'NONE' };
    deps.presenter.hide();
    return true;
  }

  return {
    get: (): AttentionPrompt => active,
    requestIdle,
    beginMachineAway,
    requestAway,
    requestPermission,
    yieldPermissionToSystemSettings,
    restoreActive,
    clear,
    isPermissionActive: () => active.kind === 'PERMISSION',
  };
}

let singleton: ReturnType<typeof createTrackingAttentionCoordinator> | null = null;

export function getTrackingAttentionCoordinator() {
  if (!singleton) {
    singleton = createTrackingAttentionCoordinator({ id: ulid, presenter: attentionPresenter });
  }
  return singleton;
}
