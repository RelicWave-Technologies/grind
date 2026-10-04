import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
const listen = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: (...args: unknown[]) => listen(...args) }));

import { MANIFEST, commandFor, createAgentBridge, toError } from './agentBridge';

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/** Every `namespace.method` the renderer's own `Window['agent']` declaration has, read with the compiler. */
function declaredBridgeKeys(): Record<string, string[]> {
  const file = here('../lib/agent.d.ts');
  const program = ts.createProgram([file], {
    noEmit: true,
    skipLibCheck: true,
    types: [],
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file);
  const found: Record<string, string[]> = {};
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'Window') {
      for (const member of node.members) {
        if (!ts.isPropertySignature(member) || member.name.getText() !== 'agent') continue;
        for (const ns of checker.getTypeAtLocation(member).getProperties()) {
          const type = checker.getTypeOfSymbolAtLocation(ns, member);
          found[ns.name] = type.getProperties().map((method) => method.name);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  if (source) visit(source);
  return found;
}

const bridgeOf = createAgentBridge as () => Record<string, Record<string, (...a: unknown[]) => unknown>>;

beforeEach(() => {
  invoke.mockReset();
  listen.mockReset();
  invoke.mockResolvedValue(undefined);
});

describe('every AgentBridge key is implemented', () => {
  const declared = declaredBridgeKeys();

  it('reads a believable declaration', () => {
    expect(Object.keys(declared).length).toBeGreaterThanOrEqual(14);
    expect(declared.timer).toContain('start');
  });

  it('has exactly the declared namespaces and methods, as functions', () => {
    const bridge = bridgeOf();
    expect(Object.keys(bridge).sort()).toEqual(Object.keys(declared).sort());
    for (const [namespace, methods] of Object.entries(declared)) {
      expect(Object.keys(bridge[namespace] ?? {}).sort(), namespace).toEqual([...methods].sort());
      for (const method of methods) expect(typeof bridge[namespace]?.[method], `${namespace}.${method}`).toBe('function');
    }
  });

  it('has a manifest entry for each, so the table and the bridge cannot drift', () => {
    for (const [namespace, methods] of Object.entries(declared)) {
      expect(Object.keys(MANIFEST[namespace as keyof typeof MANIFEST]).sort()).toEqual([...methods].sort());
    }
  });
});

describe('command naming', () => {
  it.each([
    ['timer:start', 'timer_start'],
    ['window:openMain', 'window_open_main'],
    ['window:dismissFloatingBar', 'window_dismiss_floating_bar'],
    ['app:relaunch', 'app_relaunch'],
    ['settings:openDataFolder', 'settings_open_data_folder'],
    ['settings:get', 'settings_get'],
    ['auth:loginWithLark', 'auth_login_with_lark'],
    ['workspaceTime:get', 'workspace_time_get'],
    ['attention:yieldToSystemSettings', 'attention_yield_to_system_settings'],
    ['settings:openInputMonitoringPrefs', 'settings_open_input_monitoring_prefs'],
  ])('%s -> %s', (channel, command) => {
    expect(commandFor(channel)).toBe(command);
  });
});

describe('requests', () => {
  it('invokes the derived command for every request method', async () => {
    const bridge = bridgeOf();
    for (const [namespace, methods] of Object.entries(MANIFEST)) {
      for (const [name, spec] of Object.entries(methods)) {
        if (!('channel' in spec) || spec.also) continue;
        invoke.mockClear();
        const arity = spec.args?.length ?? 0;
        await bridge[namespace]?.[name]?.(...Array.from({ length: arity }, () => 'x'));
        expect(invoke, `${namespace}.${name}`).toHaveBeenCalledTimes(1);
        expect(invoke.mock.calls[0]?.[0], `${namespace}.${name}`).toBe(commandFor(spec.channel));
      }
    }
  });

  it.each([
    ['auth', 'login', ['a@b.c', 'pw'], { email: 'a@b.c', password: 'pw' }],
    ['timer', 'start', ['guid-1'], { larkTaskGuid: 'guid-1' }],
    ['timer', 'start', [], { larkTaskGuid: null }],
    ['attention', 'resolve', ['p1', 'RESUME'], { promptId: 'p1', action: 'RESUME' }],
    ['attention', 'yieldToSystemSettings', ['p1'], { promptId: 'p1' }],
    ['shift', 'decide', ['yes'], { decision: 'yes' }],
    ['screenshots', 'recent', [5], { limit: 5 }],
    ['screenshots', 'recent', [], { limit: null }],
    ['screenshots', 'thumbnail', ['s1'], { id: 's1' }],
    ['screenshots', 'full', ['s1'], { id: 's1' }],
    ['settings', 'setFloatingBarVisible', [true], { enabled: true }],
    ['lark', 'createTask', [{ summary: 't' }], { input: { summary: 't' } }],
  ])('%s.%s sends named arguments', async (namespace, name, args, expected) => {
    await bridgeOf()[namespace as string]?.[name as string]?.(...(args as unknown[]));
    expect(invoke).toHaveBeenCalledWith(expect.any(String), expected);
  });

  it('passes the result through untouched', async () => {
    invoke.mockResolvedValue({ state: 'IDLE' });
    await expect(bridgeOf().timer?.status?.()).resolves.toEqual({ state: 'IDLE' });
  });
});

describe('not ported yet', () => {
  it.each([
    'Command timer_start not found',
    'timer_start not allowed. Command not found',
  ])('rewrites %j', async (tauriMessage) => {
    invoke.mockRejectedValue(tauriMessage);
    await expect(bridgeOf().timer?.start?.()).rejects.toThrow(new Error('not ported yet: timer_start'));
  });

  it('keeps every other error as it was, as an Error', async () => {
    invoke.mockRejectedValue('disk is full');
    await expect(bridgeOf().window?.openMain?.()).rejects.toThrow(new Error('disk is full'));
    expect(toError('x', { code: 7 }).message).toBe('{"code":7}');
  });

  it('does not call a permission denial "not ported"', () => {
    const denied = 'window_open_main not allowed on window "popover", webview "popover", URL: local';
    expect(toError('window_open_main', denied).message).toBe(denied);
  });

  it('settings.get merges the ported half with the unported half, and says so until both exist', async () => {
    invoke.mockImplementation((command: string) =>
      command === 'settings_get'
        ? Promise.resolve({ version: '1.0.0', platform: 'darwin' })
        : Promise.reject(new Error(`Command ${command} not found`)),
    );
    await expect(bridgeOf().settings?.get?.()).rejects.toThrow('not ported yet: settings_get_services');

    invoke.mockImplementation((command: string) =>
      Promise.resolve(command === 'settings_get' ? { version: '1.0.0', platform: 'darwin' } : { screenStatus: 'granted' }),
    );
    await expect(bridgeOf().settings?.get?.()).resolves.toEqual({
      version: '1.0.0',
      platform: 'darwin',
      screenStatus: 'granted',
    });
  });
});

describe('push events', () => {
  const stop = vi.fn();
  beforeEach(() => {
    stop.mockReset();
    listen.mockResolvedValue(stop);
  });

  it('every on* method listens on its own channel name and returns an unsubscribe', async () => {
    const bridge = bridgeOf();
    for (const [namespace, methods] of Object.entries(MANIFEST)) {
      for (const [name, spec] of Object.entries(methods)) {
        if (!('event' in spec)) continue;
        listen.mockClear();
        stop.mockClear();
        const off = bridge[namespace]?.[name]?.(() => undefined) as () => void;
        expect(typeof off, `${namespace}.${name}`).toBe('function');
        expect(listen.mock.calls[0]?.[0]).toBe(spec.event);
        await Promise.resolve();
        off();
        expect(stop, `${namespace}.${name}`).toHaveBeenCalledTimes(1);
        off();
        expect(stop).toHaveBeenCalledTimes(1);
      }
    }
  });

  it('unsubscribing before the listener is ready still removes it', async () => {
    let ready: (stopFn: () => void) => void = () => undefined;
    listen.mockReturnValue(new Promise((resolve) => (ready = resolve)));
    const off = bridgeOf().timer?.onStatusChange?.(() => undefined) as () => void;
    off();
    ready(stop);
    await Promise.resolve();
    await Promise.resolve();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('delivers the payload, and adapts the ones whose callbacks differ', async () => {
    const handlers = new Map<string, (message: { payload: unknown }) => void>();
    listen.mockImplementation((event: string, handler: (message: { payload: unknown }) => void) => {
      handlers.set(event, handler);
      return Promise.resolve(stop);
    });
    const bridge = bridgeOf();
    const status = vi.fn();
    const connection = vi.fn();
    const changed = vi.fn();
    bridge.timer?.onStatusChange?.(status);
    bridge.lark?.onConnectionChange?.(connection);
    bridge.screenshots?.onChange?.(changed);
    handlers.get('timer:status:push')?.({ payload: { state: 'IDLE' } });
    handlers.get('lark:connection:push')?.({ payload: { outcome: 'failed' } });
    handlers.get('screenshots:changed')?.({ payload: { ignored: true } });
    expect(status).toHaveBeenCalledWith({ state: 'IDLE' });
    expect(connection).toHaveBeenCalledWith('failed');
    expect(changed).toHaveBeenCalledWith();
  });
});

describe('README table', () => {
  const readme = readFileSync(here('../../README.md'), 'utf8');
  const names = readFileSync(here('../../src-tauri/src/commands/names.rs'), 'utf8');
  const ported = new Set([...names.matchAll(/^\s*"([a-z_]+)",?$/gm)].map((m) => m[1]));
  const rows = new Map(
    [...readme.matchAll(/^\| `([^`]+)` \| `([a-z_]+)` \| (ported|not ported) \|$/gm)].map((m) => [m[1], { command: m[2], status: m[3] }]),
  );

  it('lists every request channel with its command and whether Rust has it', () => {
    const channels = Object.values(MANIFEST).flatMap((methods) =>
      Object.values(methods).flatMap((spec) => ('channel' in spec ? [spec.channel, ...(spec.also ?? [])] : [])),
    );
    for (const channel of channels) {
      const command = commandFor(channel);
      const row = rows.get(channel);
      expect(row, `README has no row for ${channel}`).toBeDefined();
      expect(row?.command).toBe(command);
      expect(row?.status, `${channel} status`).toBe(ported.has(command) ? 'ported' : 'not ported');
    }
  });

  it('lists every push event', () => {
    for (const methods of Object.values(MANIFEST)) {
      for (const spec of Object.values(methods)) {
        if ('event' in spec) expect(readme, spec.event).toContain(`\`${spec.event}\``);
      }
    }
  });
});
