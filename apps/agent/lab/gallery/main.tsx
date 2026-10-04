import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { isLabFrameMessage } from '../bridge/messages';
import {
  DEFAULT_SCENARIO,
  SCENARIO_FIELDS,
  SCENARIO_OPTIONS,
  scenarioFromParams,
  scenarioToParams,
  type Scenario,
  type ScenarioField,
} from '../bridge/scenario';
import { WorldStore } from '../bridge/store';
import { larkStatus, readiness, taskView, timerStatus, updateStatus, type World } from '../bridge/world';
import { GROUPS, SURFACES, TRAFFIC_LIGHTS, surfaceUrl, type SurfaceSpec } from './surfaces';
import { PALETTES, PALETTE_IDS } from '../palettes';
import './gallery.css';

// ── controls ────────────────────────────────────────────────────────────────

const CONTROLS: { [K in ScenarioField]: { label: string; options: Record<Scenario[K], string>; shownWhen?: (s: Scenario) => boolean } } = {
  auth: { label: 'Session', options: { in: 'Signed in', out: 'Signed out' } },
  login: { label: 'Sign-in result', options: { success: 'Success', pending: 'Awaiting admin', error: 'Denied' }, shownWhen: (s) => s.auth === 'out' },
  timer: { label: 'Timer', options: { idle: 'Idle', running: 'Running', paused: 'Paused' } },
  day: { label: 'Day', options: { busy: 'Busy day', empty: 'Empty day' } },
  lark: { label: 'Lark', options: { connected: 'Connected', disconnected: 'Not connected', reauth: 'Reauth', offline: 'Offline', unconfigured: 'Not set up' } },
  perms: { label: 'Permissions', options: { ready: 'Ready', grant: 'Needs grant', restart: 'Needs restart' } },
  update: { label: 'Update', options: { current: 'Up to date', downloading: 'Downloading', ready: 'Ready' } },
  notice: { label: 'Recovery notice', options: { off: 'None', sleep: 'After sleep', shutdown: 'After crash' } },
  shots: { label: 'Screenshots', options: { uploaded: 'Uploaded', uploading: 'Uploading', failed: 'Failed' } },
  wtime: { label: 'Workspace time', options: { synced: 'Synced', syncing: 'Syncing' } },
  theme: { label: 'App theme', options: { light: 'Light', dark: 'Dark', system: 'System' } },
  pill: { label: 'Pill theme', options: { light: 'Light', dark: 'Dark' } },
};

type Zoom = 1 | 0.75 | 0.5;
interface View { zoom: Zoom; backdrop: 'light' | 'dark'; bounds: boolean; palette: string }
const DEFAULT_VIEW: View = { zoom: 0.75, backdrop: 'light', bounds: true, palette: 'emiac' };
const ZOOMS: Zoom[] = [1, 0.75, 0.5];

// ── persistence: URL first (shareable), then localStorage ──────────────────

const SAVED_KEY = 'timo-agent-lab:gallery';

function loadInitial(): { scenario: Scenario; view: View } {
  const url = new URLSearchParams(window.location.search);
  let saved: { scenario?: Partial<Scenario>; view?: Partial<View> } = {};
  try {
    saved = JSON.parse(localStorage.getItem(SAVED_KEY) ?? '{}') as typeof saved;
  } catch {
    saved = {};
  }
  const urlHasState = [...SCENARIO_FIELDS, 'zoom', 'backdrop', 'bounds', 'palette'].some((key) => url.has(key));
  const knownPalette = (id: string | null | undefined) => (id && id in PALETTES ? id : DEFAULT_VIEW.palette);
  if (urlHasState) {
    const zoom = Number(url.get('zoom') ?? DEFAULT_VIEW.zoom);
    return {
      scenario: scenarioFromParams(url),
      view: {
        zoom: ZOOMS.find((z) => z === zoom) ?? DEFAULT_VIEW.zoom,
        backdrop: url.get('backdrop') === 'dark' ? 'dark' : 'light',
        bounds: url.get('bounds') !== '0',
        palette: knownPalette(url.get('palette')),
      },
    };
  }
  return {
    scenario: scenarioFromParams(new URLSearchParams(Object.entries(saved.scenario ?? {}) as [string, string][])),
    view: {
      zoom: ZOOMS.find((z) => z === saved.view?.zoom) ?? DEFAULT_VIEW.zoom,
      backdrop: saved.view?.backdrop === 'dark' ? 'dark' : 'light',
      bounds: saved.view?.bounds !== false,
      palette: knownPalette(saved.view?.palette),
    },
  };
}

function persist(scenario: Scenario, view: View): void {
  const params = scenarioToParams(scenario);
  if (view.zoom !== DEFAULT_VIEW.zoom) params.set('zoom', String(view.zoom));
  if (view.backdrop !== DEFAULT_VIEW.backdrop) params.set('backdrop', view.backdrop);
  if (!view.bounds) params.set('bounds', '0');
  if (view.palette !== DEFAULT_VIEW.palette) params.set('palette', view.palette);
  const query = params.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
  localStorage.setItem(SAVED_KEY, JSON.stringify({ scenario, view }));
}

// ── helpers ────────────────────────────────────────────────────────────────

function clock(ms: number): string {
  const t = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(t / 3600))}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`;
}

function useWorld(store: WorldStore): World {
  const [, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    const off = store.subscribe(bump);
    const timer = window.setInterval(bump, 1000);
    return () => {
      off();
      window.clearInterval(timer);
    };
  }, [store]);
  return store.get();
}

/** Where the real app would not show a surface at all, say so on its label. */
function hiddenReason(spec: SurfaceSpec, world: World): string | null {
  if (spec.id !== 'floating') return null;
  if (!world.floatingBarVisible) return 'Off in Settings — not shown';
  if (!world.openEntryId) return 'Not tracking — not shown';
  return null;
}

interface Toast { id: number; where: string; text: string }

// ── app ────────────────────────────────────────────────────────────────────

const initial = loadInitial();
// Created before the first render, so the world exists before any frame boots.
const initialStore = new WorldStore(initial.scenario);

function App() {
  const [scenario, setScenario] = useState(initial.scenario);
  const [view, setView] = useState(initial.view);
  const [store, setStore] = useState(initialStore);
  const [nonce, setNonce] = useState(0);
  const [hidden, setHidden] = useState<Record<string, string>>({});
  const [flash, setFlash] = useState<Record<string, number>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const world = useWorld(store);

  useEffect(() => persist(scenario, view), [scenario, view]);

  // Messages from surfaces: window hides/shows, focus requests, side effects.
  useEffect(() => {
    let seq = 0;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || !isLabFrameMessage(event.data)) return;
      const message = event.data;
      const where = SURFACES.find((s) => s.id === message.frame)?.title ?? message.frame;
      if (message.type === 'window') {
        setHidden((current) => {
          const next = { ...current };
          if (message.action === 'hide') next[message.frame] = message.note ?? 'Hidden';
          else delete next[message.frame];
          return next;
        });
      } else if (message.type === 'error') {
        setErrors((current) => ({ ...current, [message.frame]: [...(current[message.frame] ?? []), message.text].slice(-5) }));
      } else if (message.type === 'focus') {
        const targets = SURFACES.filter((s) => (message.target === 'main' ? s.group === 'main' : s.id === 'prompt-permission'));
        const until = Date.now() + 1600;
        setFlash((current) => ({ ...current, ...Object.fromEntries(targets.map((s) => [s.id, until])) }));
        window.setTimeout(() => setFlash((current) => Object.fromEntries(Object.entries(current).filter(([, t]) => t > Date.now()))), 1700);
      } else {
        const id = ++seq;
        setToasts((current) => [...current.slice(-4), { id, where, text: message.text }]);
        window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4500);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Read through a ref so two changes in one tick don't overwrite each other.
  const scenarioRef = useRef(scenario);
  const storeRef = useRef(store);
  const changeScenario = (patch: Partial<Scenario>) => {
    const next = { ...scenarioRef.current, ...patch };
    scenarioRef.current = next;
    // Seed the new world BEFORE the frames navigate, so they all join it.
    const nextStore = new WorldStore(next, { reseed: true });
    storeRef.current.close();
    storeRef.current = nextStore;
    setStore(nextStore);
    setScenario(next);
    setHidden({});
    setErrors({});
    setNonce((n) => n + 1);
  };
  const resetData = () => {
    storeRef.current.reseed(scenarioRef.current);
    setHidden({});
    setErrors({});
    setNonce((n) => n + 1);
  };

  const status = timerStatus(world, Date.now());
  const runningTask = status.state === 'RUNNING' ? taskView(world, Date.now()).find((t) => t.guid === status.larkTaskGuid) : undefined;
  const lark = larkStatus(world);
  const perms = readiness(world, Date.now());
  const update = updateStatus(world, Date.now());

  return (
    <div className={`lab-app lab-backdrop-${view.backdrop}`} style={{ '--lab-zoom': view.zoom } as CSSProperties}>
      <aside className="lab-panel">
        <header className="lab-panel-head">
          <div className="lab-title">Timo <span>Agent Lab</span></div>
          <p className="lab-muted">The desktop renderer on a fake bridge. Edits under <code>src/renderer</code> hot-reload in every frame.</p>
        </header>

        <section className="lab-live" aria-live="polite">
          <div className="lab-live-row">
            <span className={`lab-dot lab-dot--${status.state === 'RUNNING' ? (status.paused ? 'paused' : 'running') : 'idle'}`} />
            <strong>{status.state === 'RUNNING' ? (status.paused ? 'Paused' : 'Tracking') : 'Not tracking'}</strong>
            <span className="lab-mono">{clock(status.workedMs)}</span>
          </div>
          {runningTask && <div className="lab-live-task" title={runningTask.summary}>{runningTask.summary}</div>}
          <div className="lab-live-facts">
            <span>{world.auth === 'loggedIn' ? 'Signed in' : 'Signed out'}</span>
            <span>Lark {lark.connected ? 'connected' : lark.reauthRequired ? 'needs reauth' : lark.offline ? 'offline' : lark.configured ? 'not connected' : 'not set up'}</span>
            <span>Permissions {perms.ready ? 'ready' : 'blocked'}</span>
            <span>Update {update.phase}{update.phase === 'downloading' && update.percent !== null ? ` ${Math.round(update.percent)}%` : ''}</span>
          </div>
        </section>

        <div className="lab-controls">
          {SCENARIO_FIELDS.map((field) => {
            const control = CONTROLS[field];
            if (control.shownWhen && !control.shownWhen(scenario)) return null;
            return (
              <Segmented
                key={field}
                label={control.label}
                value={scenario[field]}
                options={SCENARIO_OPTIONS[field].map((value) => [value, (control.options as Record<string, string>)[value] ?? value])}
                onChange={(value) => changeScenario({ [field]: value })}
              />
            );
          })}
        </div>

        <div className="lab-controls lab-controls--view">
          <Segmented
            label="Palette"
            value={view.palette}
            options={PALETTE_IDS.map((id) => [id, PALETTES[id]!.label])}
            onChange={(value) => setView({ ...view, palette: value })}
          />
          <p className="lab-palette-note">{PALETTES[view.palette]?.note}</p>
          <Segmented
            label="Zoom"
            value={String(view.zoom)}
            options={ZOOMS.map((z) => [String(z), `${z * 100}%`])}
            onChange={(value) => setView({ ...view, zoom: Number(value) as Zoom })}
          />
          <Segmented
            label="Desktop"
            value={view.backdrop}
            options={[['light', 'Light'], ['dark', 'Dark']]}
            onChange={(value) => setView({ ...view, backdrop: value === 'dark' ? 'dark' : 'light' })}
          />
          <Segmented
            label="Overlay window bounds"
            value={view.bounds ? 'on' : 'off'}
            options={[['on', 'Outlined'], ['off', 'Hidden']]}
            onChange={(value) => setView({ ...view, bounds: value === 'on' })}
          />
        </div>

        <div className="lab-actions">
          <button type="button" className="lab-button" onClick={resetData} title="Throw away clicks made in the frames and start this scenario again">Reset data</button>
          <button type="button" className="lab-button" onClick={() => { setErrors({}); setNonce((n) => n + 1); }} title="Reload every frame, keeping the current data">Reload frames</button>
          <button type="button" className="lab-button lab-button--quiet" onClick={() => changeScenario(DEFAULT_SCENARIO)}>Defaults</button>
        </div>
      </aside>

      <main className="lab-canvas">
        {GROUPS.map((group) => {
          const items = SURFACES.filter((s) => s.group === group.id && (s.shownWhen?.(scenario) ?? true));
          if (items.length === 0) return null;
          return (
            <section key={group.id} className="lab-group">
              <header className="lab-group-head">
                <h2>{group.title}</h2>
                <p>{group.note}</p>
              </header>
              <div className="lab-row">
                {items.map((spec) => (
                  <Frame
                    key={spec.id}
                    spec={spec}
                    src={surfaceUrl(spec, scenario, view.palette)}
                    zoom={view.zoom}
                    bounds={view.bounds}
                    nonce={nonce}
                    veil={hidden[spec.id] ?? null}
                    errors={errors[spec.id] ?? []}
                    badge={hiddenReason(spec, world)}
                    flashing={(flash[spec.id] ?? 0) > Date.now()}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </main>

      <div className="lab-toasts" role="status">
        {toasts.map((toast) => (
          <div key={toast.id} className="lab-toast">
            <span className="lab-toast-where">{toast.where}</span>
            {toast.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function Segmented({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
}) {
  return (
    <fieldset className="lab-field">
      <legend>{label}</legend>
      <div className="lab-seg" role="radiogroup" aria-label={label}>
        {options.map(([key, text]) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={key === value}
            className={`lab-seg-item${key === value ? ' is-on' : ''}`}
            onClick={() => key !== value && onChange(key)}
          >
            {text}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function Frame({ spec, src, zoom, bounds, nonce, veil, errors, badge, flashing }: {
  spec: SurfaceSpec;
  src: string;
  zoom: Zoom;
  bounds: boolean;
  nonce: number;
  veil: string | null;
  errors: string[];
  badge: string | null;
  flashing: boolean;
}) {
  const openAlone = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    // A popup's width/height set its viewport, so the surface gets its real size.
    window.open(src, `timo-lab-${spec.id}`, `popup=yes,width=${spec.width},height=${spec.height}`);
  };
  const classes = ['lab-frame', `lab-frame--${spec.chrome}`, bounds ? 'has-bounds' : '', flashing ? 'is-flashing' : '', errors.length ? 'has-errors' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <figure className={classes}>
      <figcaption className="lab-caption">
        <span className="lab-caption-title">{spec.title}</span>
        <span className="lab-caption-size">{spec.width}×{spec.height}</span>
        {badge && <span className="lab-badge">{badge}</span>}
        {errors.length > 0 && (
          <span className="lab-badge lab-badge--error" title={errors.join('\n')}>
            {errors.length} error{errors.length === 1 ? '' : 's'} — {errors[errors.length - 1]}
          </span>
        )}
        <a className="lab-open" href={src} target="_blank" rel="noreferrer" onClick={openAlone} title="Open this surface alone at its real size (⌘-click for a full tab)">
          Open alone ↗
        </a>
      </figcaption>
      <div className="lab-window" style={{ width: spec.width * zoom, height: spec.height * zoom }}>
        <div className="lab-stage" style={{ width: spec.width, height: spec.height, transform: `scale(${zoom})` }}>
          <iframe key={nonce} src={src} title={`${spec.title} (${spec.width}×${spec.height})`} width={spec.width} height={spec.height} />
          {spec.chrome === 'window' && (
            <span className="lab-lights" style={{ left: TRAFFIC_LIGHTS.x, top: TRAFFIC_LIGHTS.y, gap: TRAFFIC_LIGHTS.gap }} aria-hidden>
              <i style={{ width: TRAFFIC_LIGHTS.size, height: TRAFFIC_LIGHTS.size }} />
              <i style={{ width: TRAFFIC_LIGHTS.size, height: TRAFFIC_LIGHTS.size }} />
              <i style={{ width: TRAFFIC_LIGHTS.size, height: TRAFFIC_LIGHTS.size }} />
            </span>
          )}
        </div>
        {veil && (
          <div className="lab-veil">
            <span>{veil}</span>
            <small>window hidden · comes back in a moment</small>
          </div>
        )}
      </div>
    </figure>
  );
}

const root = document.getElementById('lab-root');
if (!root) throw new Error('#lab-root not found');
createRoot(root).render(<App />);
