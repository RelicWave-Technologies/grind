import type { Appearance } from '../../src/shared/appearance';
import type { UserDto } from '@grind/types';
import type { AttentionAction, AttentionPrompt } from '../../src/shared/attention';
import type { LaunchAtLoginHealth } from '../../src/shared/launchAtLogin';
import type { ShiftPromptReason } from '../../src/shared/shift';
import type { TimerPauseReason, TimerStatus, TrackingCommandResult } from '../../src/shared/tracking';
import type { WorkspaceTimeContext } from '../../src/shared/workspaceTime';
import type { UpdateStatus } from '../../src/renderer/lib/agent.d';
import { tellGallery } from './messages';
import { avatarDataUrl, screenshotDataUrl } from './screenshots';
import { ME } from './seed';
import type { WorldStore } from './store';
import {
  TIME,
  insights,
  larkStatus,
  larkTasks,
  openEntry,
  openSegment,
  readiness,
  taskView,
  timerStatus,
  updateStatus,
  workspaceDay,
  workspaceTimeContext,
  type AgentBridge,
  type World,
} from './world';

export type Surface = 'main' | 'popover' | 'floating' | 'attention' | 'ready-to-work';
export type PinnedPrompt = Exclude<AttentionPrompt['kind'], 'NONE'>;

/** Who this bridge is serving: which window, and what it is pinned to show. */
export interface FrameContext {
  /** Gallery frame id (for window messages), or 'alone'. */
  frame: string;
  surface: Surface;
  /** The attention window shows one kind at a time; each lab frame is pinned to one. */
  prompt: PinnedPrompt;
  reason: ShiftPromptReason;
}

type LarkOutcome = Parameters<Parameters<AgentBridge['auth']['onLarkOutcome']>[0]>[0];
type LarkConnectionOutcome = Parameters<Parameters<AgentBridge['lark']['onConnectionChange']>[0]>[0];

interface EventMap {
  auth: 'loggedIn' | 'loggedOut';
  larkOutcome: LarkOutcome;
  timer: TimerStatus;
  attention: AttentionPrompt;
  shiftReason: ShiftPromptReason;
  shots: undefined;
  updates: UpdateStatus;
  openSettings: undefined;
  settingsOpen: undefined;
  larkConnection: LarkConnectionOutcome;
  workspaceTime: WorkspaceTimeContext;
  appearance: Appearance;
}

/** The renderer's `on*(cb)` subscriptions: subscribe, get an unsubscribe back. */
class Events {
  private readonly handlers = new Map<keyof EventMap, Set<(value: never) => void>>();

  on<K extends keyof EventMap>(name: K, cb: (value: EventMap[K]) => void): () => void {
    let set = this.handlers.get(name);
    if (!set) this.handlers.set(name, (set = new Set()));
    const handler = cb as (value: never) => void;
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  emit<K extends keyof EventMap>(name: K, value: EventMap[K]): void {
    for (const handler of this.handlers.get(name) ?? []) (handler as (value: EventMap[K]) => void)(structuredClone(value));
  }
}

const ALLOWED_ACTIONS: Record<PinnedPrompt, AttentionAction[]> = {
  IDLE_WARNING: ['IDLE_WARNING_CONTINUE'],
  IDLE: ['IDLE_CONTINUE', 'IDLE_BREAK'],
  AWAY: ['AWAY_RESUME', 'AWAY_DISMISS'],
  PERMISSION: ['PERMISSION_RETRY', 'PERMISSION_CLOSE'],
};

const ACTION_NOTES: Record<AttentionAction, string> = {
  IDLE_WARNING_CONTINUE: 'Answered “Still working”',
  IDLE_CONTINUE: 'Answered “Continue” — timer resumed',
  IDLE_BREAK: 'Answered “Take a break” — timer stopped',
  AWAY_RESUME: 'Answered “Resume” — tracking restarted',
  AWAY_DISMISS: 'Answered “Not now”',
  PERMISSION_RETRY: 'Tracking started',
  PERMISSION_CLOSE: 'Closed',
};

const REARM_MS = 2500;

/**
 * A fake `window.agent`. Same shape as the preload bridge, typed against the
 * declaration the renderer compiles with, so a bridge change that the lab
 * does not follow fails `typecheck`. Every method answers from the shared
 * world; mutations commit to it, which syncs every other surface.
 */
export function createBridge(store: WorldStore, ctx: FrameContext): AgentBridge {
  const events = new Events();
  const now = () => Date.now();
  const w = () => store.get();
  const copy = <T,>(value: T): T => structuredClone(value);
  const later = (ms: number, fn: () => void) => window.setTimeout(fn, ms);
  const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
  const effect = (text: string) => tellGallery(ctx.frame, { type: 'effect', text });

  // World changes (local or from another surface) → the renderer's push events.
  store.subscribe((world, prev, changed) => {
    const t = now();
    if (changed.has('auth') && world.auth !== prev.auth) events.emit('auth', world.auth);
    if (changed.has('timer')) events.emit('timer', timerStatus(world, t));
    if (changed.has('shots')) events.emit('shots', undefined);
    if (changed.has('appearance')) events.emit('appearance', world.appearance);
    // canInstallNow depends on whether a session is open.
    if (changed.has('updates') || changed.has('timer')) events.emit('updates', updateStatus(world, t));
    if (changed.has('lark') && world.larkMode === 'connected' && prev.larkMode !== 'connected') {
      events.emit('larkConnection', 'connected');
    }
  });

  // The real main process pushes the timer every second while a session is
  // open (paused included). Download progress moves on the same beat.
  let lastUpdate = '';
  window.setInterval(() => {
    const world = w();
    const t = now();
    if (world.openEntryId) events.emit('timer', timerStatus(world, t));
    if (world.update.phase === 'downloading') {
      const status = updateStatus(world, t);
      const key = JSON.stringify(status);
      if (key !== lastUpdate) {
        lastUpdate = key;
        events.emit('updates', status);
      }
    }
  }, 1000);

  // ── timer ────────────────────────────────────────────────────────────────

  const isReady = () => readiness(w(), now()).ready;

  const permissionsRequired = (): TrackingCommandResult => {
    effect('Blocked until permissions are ready — the permission prompt opens');
    tellGallery(ctx.frame, { type: 'focus', target: 'permission' });
    return { ok: false, reason: 'PERMISSIONS_REQUIRED', status: timerStatus(w(), now()), readiness: readiness(w(), now()) };
  };

  const closeOpenSegment = (world: World, at: number) => {
    const entry = openEntry(world);
    const segment = entry ? openSegment(entry) : null;
    if (segment) segment.endedAt = at;
  };

  const startTimer = (guid: string | null): TrackingCommandResult => {
    if (!isReady()) return permissionsRequired();
    const current = openEntry(w());
    if (current && current.larkTaskGuid === guid) return { ok: true, status: timerStatus(w(), now()) };
    const at = now();
    store.commit(['timer'], (draft) => {
      closeOpenSegment(draft, at);
      const id = `lab-entry-${at.toString(36)}`;
      draft.entries.push({ id, source: 'AUTO', larkTaskGuid: guid, segments: [{ kind: 'WORK', startedAt: at, endedAt: null }] });
      draft.openEntryId = id;
      draft.entryRevision += 1;
      draft.pauseReason = null;
      if (guid) draft.lastTaskGuid = guid;
    });
    return { ok: true, status: timerStatus(w(), now()) };
  };

  const pauseTimer = (reason: TimerPauseReason): TimerStatus => {
    const entry = openEntry(w());
    if (entry && openSegment(entry)) {
      store.commit(['timer'], (draft) => {
        closeOpenSegment(draft, now());
        draft.pauseReason = reason;
        draft.entryRevision += 1;
      });
    }
    return timerStatus(w(), now());
  };

  const resumeTimer = (): TrackingCommandResult => {
    const entry = openEntry(w());
    if (!entry || openSegment(entry)) return { ok: true, status: timerStatus(w(), now()) };
    if (!isReady()) return permissionsRequired();
    store.commit(['timer'], (draft) => {
      openEntry(draft)?.segments.push({ kind: 'WORK', startedAt: now(), endedAt: null });
      draft.pauseReason = null;
      draft.entryRevision += 1;
    });
    return { ok: true, status: timerStatus(w(), now()) };
  };

  const stopTimer = (): TimerStatus => {
    if (w().openEntryId) {
      store.commit(['timer'], (draft) => {
        closeOpenSegment(draft, now());
        draft.openEntryId = null;
        draft.pauseReason = null;
        draft.entryRevision += 1;
      });
    }
    return timerStatus(w(), now());
  };

  // ── attention (frame-local: each prompt frame is pinned to one kind) ─────

  let armed = 0;
  const arm = (): AttentionPrompt => {
    armed += 1;
    const promptId = `lab-${ctx.prompt.toLowerCase()}-${armed}`;
    const at = now();
    switch (ctx.prompt) {
      case 'IDLE_WARNING':
        return { kind: 'IDLE_WARNING', promptId, idleStartedAt: at - 90_000, deadlineAt: at + 30_000 };
      case 'IDLE':
        return { kind: 'IDLE', promptId, idleStartedAt: at - 5 * TIME.MINUTE };
      case 'AWAY':
        return { kind: 'AWAY', promptId, larkTaskGuid: w().lastTaskGuid, stoppedAt: at - 47 * TIME.MINUTE, reason: 'suspend' };
      case 'PERMISSION':
        return { kind: 'PERMISSION', promptId, intent: 'START_TASK', presentation: 'FRONT' };
    }
  };
  let prompt: AttentionPrompt = ctx.surface === 'attention' ? arm() : { kind: 'NONE' };
  const setPrompt = (next: AttentionPrompt) => {
    prompt = next;
    events.emit('attention', next);
  };
  const hideAndRearm = (note: string) => {
    setPrompt({ kind: 'NONE' });
    tellGallery(ctx.frame, { type: 'window', action: 'hide', note });
    later(REARM_MS, () => {
      setPrompt(arm());
      tellGallery(ctx.frame, { type: 'window', action: 'show' });
    });
  };
  if (ctx.surface === 'attention' && ctx.prompt === 'IDLE_WARNING') {
    // The real countdown ends in a pause + the idle prompt; here it just loops.
    window.setInterval(() => {
      if (prompt.kind === 'IDLE_WARNING' && now() >= prompt.deadlineAt) setPrompt(arm());
    }, 500);
  }

  // ── misc shapes ──────────────────────────────────────────────────────────

  const launchAtLogin = (): LaunchAtLoginHealth => ({
    required: true,
    ready: true,
    state: 'READY',
    canRepair: false,
    remediation: 'NONE',
    openedAtLogin: true,
    checkedAt: new Date(now()).toISOString(),
  });

  const me = () => ({ name: ME.name, avatarUrl: avatarDataUrl(ME.name) });

  const user = (email: string): UserDto => ({
    id: ME.id,
    email,
    name: ME.name,
    role: 'MEMBER',
    activityRoleTitle: 'DESIGNER',
    displayRole: 'MEMBER',
    capabilities: [],
    workspaceId: 'lab-workspace',
    workspaceTimezone: 'Asia/Kolkata',
    teamId: 'lab-team',
    managerId: 'lab-user-priya',
    provisioningStatus: 'ACTIVE',
    avatarUrl: me().avatarUrl,
  });

  const shotsToday = () => {
    const day = workspaceDay(now());
    return w().shots.filter((shot) => shot.capturedAt >= day.start && shot.capturedAt < day.end);
  };

  const settleShots = (ids: string[], ms: number) => later(ms, () => {
    store.commit(['shots'], (draft) => {
      for (const shot of draft.shots) {
        if (!ids.includes(shot.id)) continue;
        shot.uploadState = 'uploaded';
        shot.attempts = Math.max(1, shot.attempts);
        shot.lastError = null;
      }
    });
  });

  // ── the bridge ───────────────────────────────────────────────────────────

  const bridge: AgentBridge = {
    auth: {
      login: async (email) => {
        store.commit(['auth'], (draft) => {
          draft.auth = 'loggedIn';
        });
        return user(email);
      },
      loginWithLark: async () => {
        effect('Browser opens Lark sign-in');
        const outcome = w().scenario.login;
        later(1800, () => {
          if (outcome === 'success') {
            store.commit(['auth'], (draft) => {
              draft.auth = 'loggedIn';
            });
          } else {
            events.emit('larkOutcome', outcome === 'pending' ? { kind: 'pending' } : { kind: 'error', reason: 'denied' });
          }
        });
        return { ok: true };
      },
      logout: async () => {
        store.commit(['auth'], (draft) => {
          draft.auth = 'loggedOut';
        });
        return { ok: true };
      },
      status: async () => w().auth,
      me: async () => (w().auth === 'loggedIn' ? me() : null),
      onStatusChange: (cb) => events.on('auth', cb),
      onLarkOutcome: (cb) => events.on('larkOutcome', cb),
    },
    agent: {
      status: async () => ({ state: 'IDLE', lastHeartbeatAt: new Date(now() - 12_000).toISOString() }),
    },
    workspaceTime: {
      get: async () => workspaceTimeContext(w(), now()),
      onChange: (cb) => events.on('workspaceTime', cb),
    },
    timer: {
      start: async (guid) => startTimer(guid ?? null),
      pause: async () => pauseTimer('MANUAL'),
      stop: async () => stopTimer(),
      resume: async () => resumeTimer(),
      status: async () => timerStatus(w(), now()),
      lastTaskGuid: async () => w().lastTaskGuid,
      recoveryNotice: async () => copy(w().notice),
      dismissRecoveryNotice: async () => {
        store.commit(['notice'], (draft) => {
          draft.notice = null;
        });
        return { ok: true };
      },
      today: async () => copy([...w().entries].reverse()),
      onStatusChange: (cb) => events.on('timer', cb),
    },
    window: {
      openMain: async () => {
        effect('Main window comes to the front');
        tellGallery(ctx.frame, { type: 'focus', target: 'main' });
      },
      dismissFloatingBar: async () => {
        tellGallery(ctx.frame, { type: 'window', action: 'hide', note: 'Dismissed — hidden until the next session' });
        later(3000, () => tellGallery(ctx.frame, { type: 'window', action: 'show' }));
      },
    },
    attention: {
      get: async () => copy(prompt),
      resolve: async (promptId, action) => {
        const current = prompt;
        if (current.kind === 'NONE' || current.promptId !== promptId) return { ok: false, reason: 'STALE_PROMPT' };
        if (!ALLOWED_ACTIONS[current.kind].includes(action)) return { ok: false, reason: 'ACTION_NOT_ALLOWED' };
        let command: TrackingCommandResult | null = null;
        if (action === 'IDLE_CONTINUE') command = resumeTimer();
        if (action === 'IDLE_BREAK') command = { ok: true, status: stopTimer() };
        if (action === 'AWAY_RESUME' && current.kind === 'AWAY') command = startTimer(current.larkTaskGuid);
        if (action === 'PERMISSION_RETRY') command = w().openEntryId ? resumeTimer() : startTimer(w().lastTaskGuid);
        // A refused retry leaves the permission prompt up, as the real one does.
        if (!command || command.ok) hideAndRearm(ACTION_NOTES[action]);
        return { ok: true, command };
      },
      yieldToSystemSettings: async () => {
        effect('Prompt steps back while System Settings opens');
        return { ok: true };
      },
      onChange: (cb) => events.on('attention', cb),
    },
    shift: {
      decide: async (decision) => {
        effect(decision === 'yes' ? 'Main window opens so you can pick a task' : 'Snoozed — asks again in 5 minutes');
        if (decision === 'yes') tellGallery(ctx.frame, { type: 'focus', target: 'main' });
        tellGallery(ctx.frame, { type: 'window', action: 'hide', note: decision === 'yes' ? 'Answered “Yes”' : 'Snoozed' });
        later(REARM_MS, () => tellGallery(ctx.frame, { type: 'window', action: 'show' }));
      },
      refresh: async () => undefined,
      today: async () => {
        if (w().scenario.wtime === 'syncing') return null;
        const day = workspaceDay(now());
        return { name: 'General shift', start: '10:00', end: '19:00', startedAt: day.start + 10 * TIME.HOUR, endedAt: day.start + 19 * TIME.HOUR };
      },
      promptReason: async () => ctx.reason,
      onPromptReason: (cb) => events.on('shiftReason', cb),
    },
    screenshots: {
      recent: async (limit = 50) => copy(w().shots.slice(0, limit)),
      countToday: async () => shotsToday().length,
      captureOnce: async () => {
        const at = now();
        const id = `lab-shot-${at}`;
        store.commit(['shots'], (draft) => {
          draft.shots.unshift({ id, capturedAt: at, uploadState: 'pending', keyboardPct: 46, mousePct: 31, attempts: 0, lastError: null });
        });
        settleShots([id], 2000);
        return shotsToday().length;
      },
      thumbnail: async (id) => screenshotDataUrl(id),
      full: async (id) => screenshotDataUrl(id),
      uploadSummary: async () => {
        const count = (state: string) => w().shots.filter((shot) => shot.uploadState === state).length;
        return { pending: count('pending'), uploading: count('uploading'), failed: count('failed') };
      },
      retryFailedUploads: async () => {
        const ids = w().shots.filter((shot) => shot.uploadState === 'failed').map((shot) => shot.id);
        if (ids.length > 0) {
          store.commit(['shots'], (draft) => {
            for (const shot of draft.shots) {
              if (ids.includes(shot.id)) {
                shot.uploadState = 'pending';
                shot.lastError = null;
              }
            }
          });
          settleShots(ids, 2500);
        }
        return { reset: ids.length };
      },
      onChange: (cb) => events.on('shots', () => cb()),
    },
    permissions: {
      readiness: async () => readiness(w(), now()),
      requestScreen: async () => {
        effect('macOS asks for Screen Recording access');
        later(1500, () => store.commit(['perms'], (draft) => {
          if (draft.perms.screenRecording === 'NEEDS_GRANT') draft.perms.screenRecording = 'NEEDS_RESTART';
        }));
        return readiness(w(), now());
      },
      screen: async () => {
        const state = w().perms.screenRecording;
        const ok = state === 'READY' || state === 'NOT_REQUIRED';
        return {
          status: state === 'NEEDS_GRANT' ? 'not-determined' : 'granted',
          health: ok ? 'healthy' : 'blocked',
          state: ok ? 'ok' : state === 'NEEDS_GRANT' ? 'needs-grant' : state === 'NEEDS_SETTINGS' ? 'needs-settings' : 'needs-restart',
        };
      },
      accessibility: async () => {
        const trusted = w().perms.accessibility === 'READY';
        const running = w().openEntryId !== null;
        return { trusted, capturing: trusted && running, ready: trusted, recording: running, hookRunning: trusted, lastHookError: null };
      },
      requestAccessibility: async () => {
        effect('macOS opens Privacy & Security › Accessibility');
        later(1500, () => store.commit(['perms'], (draft) => {
          if (draft.perms.accessibility !== 'READY') draft.perms.accessibility = 'READY';
        }));
      },
    },
    settings: {
      get: async () => ({
        version: w().update.currentVersion,
        platform: 'darwin',
        launchAtLogin: launchAtLogin(),
        screenStatus: w().perms.screenRecording === 'NEEDS_GRANT' ? 'not-determined' : 'granted',
        floatingBarVisible: w().floatingBarVisible,
      }),
      repairLaunchAtLogin: async () => launchAtLogin(),
      moveToApplications: async () => {
        effect('Timo moves itself to /Applications and relaunches');
        return { ok: true };
      },
      setFloatingBarVisible: async (enabled) => {
        store.commit(['settings'], (draft) => {
          draft.floatingBarVisible = enabled;
        });
        return enabled;
      },
      resetFloatingBarPosition: async () => effect('Floating bar snaps back to its default corner'),
      openScreenPrefs: async () => effect('System Settings opens on Screen Recording'),
      openInputMonitoringPrefs: async () => effect('System Settings opens on Input Monitoring'),
      openStartupPrefs: async () => effect('System Settings opens on Login Items'),
      onOpen: (cb) => events.on('settingsOpen', () => cb()),
      openDataFolder: async () => effect('Finder opens Timo’s data folder'),
      getAppearance: async () => ({ ...w().appearance }),
      setAppearance: async (patch) => {
        store.commit(['appearance'], (draft) => {
          draft.appearance = { ...draft.appearance, ...patch };
        });
        return { ...w().appearance };
      },
      onAppearanceChange: (cb) => events.on('appearance', cb),
    },
    app: {
      relaunch: async () => {
        effect('Timo relaunches');
        store.commit(['perms'], (draft) => {
          for (const key of ['screenRecording', 'accessibility'] as const) {
            if (draft.perms[key] === 'NEEDS_RESTART' || draft.perms[key] === 'FAILED') draft.perms[key] = 'READY';
          }
        });
      },
      openDashboard: async () => {
        effect('The web dashboard opens in the browser');
        return { ok: true };
      },
    },
    updates: {
      status: async () => updateStatus(w(), now()),
      checkNow: async () => {
        const current = updateStatus(w(), now());
        if (current.phase === 'downloading' || current.phase === 'ready' || current.phase === 'installing') return current;
        store.commit(['updates'], (draft) => {
          draft.update.phase = 'checking';
          draft.update.manual = true;
        });
        later(1200, () => store.commit(['updates'], (draft) => {
          if (draft.update.phase !== 'checking') return;
          draft.update.phase = 'not-available';
          draft.update.checkedAt = now();
        }));
        return updateStatus(w(), now());
      },
      checkQuietly: async () => updateStatus(w(), now()),
      installNow: async () => {
        const current = updateStatus(w(), now());
        if (current.phase !== 'ready' || !current.canInstallNow) return current;
        effect(`Timo quits and installs ${current.availableVersion ?? 'the update'}`);
        store.commit(['updates'], (draft) => {
          draft.update.phase = 'installing';
        });
        later(3000, () => store.commit(['updates'], (draft) => {
          if (draft.update.phase !== 'installing') return;
          draft.update.phase = 'not-available';
          draft.update.currentVersion = draft.update.availableVersion ?? draft.update.currentVersion;
          draft.update.availableVersion = null;
          draft.update.manual = false;
          draft.update.downloadStartedAt = null;
          draft.update.readyAt = null;
        }));
        return updateStatus(w(), now());
      },
      onStatusChange: (cb) => events.on('updates', cb),
      onOpenSettings: (cb) => events.on('openSettings', () => cb()),
    },
    insights: {
      today: async () => insights(w(), now()),
    },
    lark: {
      status: async () => larkStatus(w()),
      connect: async () => {
        if (w().larkMode === 'unconfigured') return { ok: false, error: 'lark_not_configured' };
        effect('Browser opens Lark authorization');
        later(1500, () => store.commit(['lark'], (draft) => {
          draft.larkMode = 'connected';
        }));
        return { ok: true };
      },
      disconnect: async () => {
        store.commit(['lark'], (draft) => {
          draft.larkMode = 'disconnected';
        });
        return { ok: true };
      },
      tasks: async () => larkTasks(w(), now()),
      sync: async () => {
        await wait(900);
        const mode = w().larkMode;
        const empty = { tasks: [], syncedAt: null };
        if (mode === 'connected') return { ok: true, connected: true, reauthRequired: false, tasks: taskView(w(), now()), syncedAt: now() };
        if (mode === 'reauth') return { ok: false, connected: true, reauthRequired: true, ...empty, error: 'reauth_required' };
        if (mode === 'offline') return { ok: false, connected: true, reauthRequired: false, ...empty, error: 'TypeError: fetch failed' };
        return { ok: false, connected: false, reauthRequired: false, ...empty };
      },
      createTask: async (input) => {
        await wait(600);
        const mode = w().larkMode;
        if (mode === 'reauth') return { ok: false, error: 'reauth_required' };
        if (mode !== 'connected') return { ok: false, error: 'Could not create task in Lark' };
        const at = now();
        store.commit(['tasks'], (draft) => {
          draft.tasks.unshift({
            guid: `lab-task-new-${at.toString(36)}`,
            summary: input.summary,
            completed: false,
            due: input.due ?? null,
            createdAt: at,
            creatorId: ME.id,
            creatorName: ME.name,
            loggedBeforeTodayMs: 0,
          });
        });
        return { ok: true };
      },
      onConnectionChange: (cb) => events.on('larkConnection', cb),
    },
  };
  return bridge;
}
