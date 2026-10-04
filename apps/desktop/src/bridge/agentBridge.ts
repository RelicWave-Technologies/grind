/**
 * `window.agent` on top of Tauri: the one module that replaces the Electron
 * preload (legacy/agent/src/preload/index.ts). The renderer talks only to
 * `window.agent`, so screens change nothing; this file maps every method to a
 * Tauri command (`invoke`) or event (`listen`) with the identical name, argument
 * shape and return type.
 *
 * Naming. An Electron channel `timer:start` is the command `timer_start`;
 * camelCase segments become snake_case (`auth:loginWithLark` ->
 * `auth_login_with_lark`). Push channels keep their names as Tauri event names
 * (`timer:status:push`). The channel -> command table is in apps/desktop/README.md
 * and a test keeps it in step with this file.
 *
 * Not ported yet. A command with no Rust handler makes Tauri reject; that is
 * rewritten to `not ported yet: <command>`. Nothing here ever returns made-up data.
 *
 * Completeness. `MANIFEST` is typed against `AgentBridge`, so a method the
 * renderer's declaration has and this file lacks (or the reverse) fails
 * `tsc`; `agentBridge.test.ts` also checks it at run time.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { SettingsInfo } from '../generated/SettingsInfo';

export type AgentBridge = Window['agent'];

type AnyFn = (...args: never[]) => unknown;

/** A method that asks the shell something (`ipcRenderer.invoke`). */
interface RequestSpec<M extends AnyFn> {
  /** The Electron channel; the Tauri command is derived (`commandFor`). */
  channel: string;
  /** Positional arguments -> the named arguments the command takes. */
  args?: (...args: Parameters<M>) => Record<string, unknown>;
  /** Further channels whose objects are merged into the result (see settings.get). */
  also?: string[];
}

/** A method that subscribes to a push event (`ipcRenderer.on`). */
interface EventSpec<M extends AnyFn> {
  /** Tauri event name; identical to the Electron push channel. */
  event: string;
  /** Event payload -> the callback's arguments (default: the payload itself). */
  adapt?: (payload: never) => Parameters<Parameters<M>[0]>;
}

type Spec<M> = M extends (...args: never[]) => Promise<unknown>
  ? RequestSpec<M>
  : M extends (callback: never) => () => void
    ? EventSpec<M>
    : never;

type Manifest = { [N in keyof AgentBridge]: { [K in keyof AgentBridge[N]]: Spec<AgentBridge[N][K]> } };

type SettingsRecord = Awaited<ReturnType<AgentBridge['settings']['get']>>;
type RustFitsRenderer<Rust, Renderer> = Rust extends Pick<Renderer, keyof Rust & keyof Renderer>
  ? keyof Rust extends keyof Renderer
    ? true
    : never
  : never;

/**
 * Compile-time contract with the Rust DTOs in `src/generated/` (ts-rs): what
 * `settings_get` returns must be a subset of the record the renderer declares.
 * Rename or retype a Rust field and `pnpm typecheck` fails here.
 */
export const RUST_DTO_CONTRACT: { settingsGet: RustFitsRenderer<SettingsInfo, SettingsRecord> } = {
  settingsGet: true,
};

export const MANIFEST: Manifest = {
  auth: {
    login: { channel: 'auth:login', args: (email, password) => ({ email, password }) },
    loginWithLark: { channel: 'auth:loginWithLark' },
    logout: { channel: 'auth:logout' },
    status: { channel: 'auth:status' },
    me: { channel: 'auth:me' },
    onStatusChange: { event: 'auth:status:push' },
    onLarkOutcome: { event: 'auth:lark:push' },
  },
  agent: {
    status: { channel: 'agent:status' },
  },
  workspaceTime: {
    get: { channel: 'workspaceTime:get' },
    onChange: { event: 'workspaceTime:push' },
  },
  timer: {
    start: { channel: 'timer:start', args: (larkTaskGuid) => ({ larkTaskGuid: larkTaskGuid ?? null }) },
    pause: { channel: 'timer:pause' },
    stop: { channel: 'timer:stop' },
    resume: { channel: 'timer:resume' },
    status: { channel: 'timer:status' },
    lastTaskGuid: { channel: 'timer:lastTaskGuid' },
    recoveryNotice: { channel: 'timer:recoveryNotice' },
    dismissRecoveryNotice: { channel: 'timer:dismissRecoveryNotice' },
    today: { channel: 'timer:today' },
    onStatusChange: { event: 'timer:status:push' },
  },
  window: {
    openMain: { channel: 'window:openMain' },
    dismissFloatingBar: { channel: 'window:dismissFloatingBar' },
  },
  attention: {
    get: { channel: 'attention:get' },
    resolve: { channel: 'attention:resolve', args: (promptId, action) => ({ promptId, action }) },
    yieldToSystemSettings: {
      channel: 'attention:yieldToSystemSettings',
      args: (promptId) => ({ promptId }),
    },
    onChange: { event: 'attention:state:push' },
  },
  shift: {
    decide: { channel: 'shift:decide', args: (decision) => ({ decision }) },
    refresh: { channel: 'shift:refresh' },
    today: { channel: 'shift:today' },
    promptReason: { channel: 'shift:promptReason' },
    onPromptReason: { event: 'shift:promptReason' },
  },
  screenshots: {
    recent: { channel: 'screenshots:recent', args: (limit) => ({ limit: limit ?? null }) },
    countToday: { channel: 'screenshots:countToday' },
    captureOnce: { channel: 'screenshots:captureOnce' },
    thumbnail: { channel: 'screenshots:thumbnail', args: (id) => ({ id }) },
    full: { channel: 'screenshots:full', args: (id) => ({ id }) },
    uploadSummary: { channel: 'screenshots:uploadSummary' },
    retryFailedUploads: { channel: 'screenshots:retryFailedUploads' },
    onChange: { event: 'screenshots:changed', adapt: () => [] },
  },
  permissions: {
    readiness: { channel: 'permissions:readiness' },
    requestScreen: { channel: 'permissions:requestScreen' },
    screen: { channel: 'permissions:screen' },
    accessibility: { channel: 'permissions:accessibility' },
    requestAccessibility: { channel: 'permissions:requestAccessibility' },
  },
  settings: {
    // `settings_get` (version, platform) is ported; the rest of the record needs
    // the launch-at-login, permission and preferences services, so it comes from
    // `settings_get_services`, which is not ported yet. Until it is, this rejects
    // with `not ported yet: settings_get_services` rather than return a record
    // with invented launchAtLogin / screenStatus / floatingBarVisible fields.
    get: { channel: 'settings:get', also: ['settings:getServices'] },
    repairLaunchAtLogin: { channel: 'settings:repairLaunchAtLogin' },
    moveToApplications: { channel: 'settings:moveToApplications' },
    setFloatingBarVisible: { channel: 'settings:setFloatingBarVisible', args: (enabled) => ({ enabled }) },
    resetFloatingBarPosition: { channel: 'settings:resetFloatingBarPosition' },
    openScreenPrefs: { channel: 'settings:openScreenPrefs' },
    openInputMonitoringPrefs: { channel: 'settings:openInputMonitoringPrefs' },
    openStartupPrefs: { channel: 'settings:openStartupPrefs' },
    onOpen: { event: 'settings:open:push', adapt: () => [] },
    openDataFolder: { channel: 'settings:openDataFolder' },
  },
  app: {
    relaunch: { channel: 'app:relaunch' },
    openDashboard: { channel: 'app:openDashboard' },
  },
  updates: {
    status: { channel: 'updates:status' },
    checkNow: { channel: 'updates:checkNow' },
    checkQuietly: { channel: 'updates:checkQuietly' },
    installNow: { channel: 'updates:installNow' },
    onStatusChange: { event: 'updates:status:push' },
    onOpenSettings: { event: 'updates:open-settings', adapt: () => [] },
  },
  insights: {
    today: { channel: 'insights:today' },
  },
  lark: {
    status: { channel: 'lark:status' },
    connect: { channel: 'lark:connect' },
    disconnect: { channel: 'lark:disconnect' },
    tasks: { channel: 'lark:tasks' },
    sync: { channel: 'lark:sync' },
    createTask: { channel: 'lark:createTask', args: (input) => ({ input }) },
    onConnectionChange: {
      event: 'lark:connection:push',
      adapt: (payload: { outcome: 'connected' | 'cancelled' | 'failed' }) => [payload.outcome],
    },
  },
};

/** `timer:start` -> `timer_start`; `auth:loginWithLark` -> `auth_login_with_lark`. */
export function commandFor(channel: string): string {
  return channel
    .split(':')
    .map((part) => part.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`))
    .join('_');
}

/** What Tauri says when no handler (or no permission entry) exists for a command. */
const UNKNOWN_COMMAND = /^Command \S+ not found$|not allowed\. Command not found/;

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : JSON.stringify(error);
}

/** Electron's `invoke` rejected with an `Error`; so does this. */
export function toError(command: string, error: unknown): Error {
  const message = messageOf(error);
  return new Error(UNKNOWN_COMMAND.test(message) ? `not ported yet: ${command}` : message);
}

async function call(channel: string, args?: Record<string, unknown>): Promise<unknown> {
  const command = commandFor(channel);
  try {
    return await invoke(command, args);
  } catch (error) {
    throw toError(command, error);
  }
}

async function callAndMerge(spec: RequestSpec<AnyFn>, args: Record<string, unknown> | undefined): Promise<unknown> {
  const parts = await Promise.all([call(spec.channel, args), ...(spec.also ?? []).map((c) => call(c))]);
  return Object.assign({}, ...(parts as object[]));
}

/** Subscribe to a push event. The unsubscribe is synchronous even though `listen` is not. */
function subscribe(event: string, deliver: (payload: unknown) => void): () => void {
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  listen(event, (message) => deliver(message.payload))
    .then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    })
    .catch((error: unknown) => console.error(`agent bridge: cannot listen to ${event}`, error));
  return () => {
    cancelled = true;
    unlisten?.();
    unlisten = null;
  };
}

function requestMethod(spec: RequestSpec<AnyFn>) {
  return (...args: unknown[]): Promise<unknown> => {
    const named = (spec.args as ((...a: unknown[]) => Record<string, unknown>) | undefined)?.(...args);
    return spec.also ? callAndMerge(spec, named) : call(spec.channel, named);
  };
}

function eventMethod(spec: EventSpec<AnyFn>) {
  return (callback: (...args: unknown[]) => void): (() => void) =>
    subscribe(spec.event, (payload) => {
      const adapt = spec.adapt as ((p: unknown) => unknown[]) | undefined;
      callback(...(adapt ? adapt(payload) : [payload]));
    });
}

/** Build the `window.agent` object from the manifest. */
export function createAgentBridge(): AgentBridge {
  const bridge: Record<string, Record<string, unknown>> = {};
  for (const [namespace, methods] of Object.entries(MANIFEST)) {
    bridge[namespace] = {};
    for (const [name, spec] of Object.entries(methods as Record<string, RequestSpec<AnyFn> | EventSpec<AnyFn>>)) {
      bridge[namespace][name] = 'event' in spec ? eventMethod(spec) : requestMethod(spec);
    }
  }
  return bridge as unknown as AgentBridge;
}
