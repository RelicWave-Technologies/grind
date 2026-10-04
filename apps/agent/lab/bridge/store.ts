import { scenarioId, type Scenario } from './scenario';
import { seedWorld } from './seed';
import { SLICES, workspaceDay, type Slice, type World } from './world';

/**
 * One replica of the fake main process per lab document.
 *
 *  - A commit clones the world, applies the mutation, bumps `rev` and the
 *    touched slices' revs, saves it to localStorage and posts it on a
 *    BroadcastChannel.
 *  - Every other document with the SAME scenario adopts it if it is newer
 *    (same seed: higher rev; different seed: later seedAt, i.e. a reset), then
 *    fires the renderer events for the slices that changed.
 *  - A document that boots late (reload, HMR full-reload, "open alone") reads
 *    the saved world instead of seeding its own, so it joins the same session.
 *
 * Surfaces with different scenarios share the channel but ignore each other.
 */

const CHANNEL = 'timo-agent-lab';
const STORAGE_KEY = 'timo-agent-lab:world';
const MAX_AGE_MS = 12 * 60 * 60_000;

type WorldMessage = { type: 'world'; world: World };
export type WorldListener = (world: World, prev: World, changed: ReadonlySet<Slice>) => void;

function readSaved(): World | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as World) : null;
  } catch {
    return null;
  }
}

function usable(world: World | null, id: string, now: number): world is World {
  return !!world
    && world.scenarioId === id
    && now - world.seedAt < MAX_AGE_MS
    // A world seeded yesterday has yesterday's entries; re-seed on a new workspace day.
    && workspaceDay(world.seedAt).date === workspaceDay(now).date;
}

export class WorldStore {
  private world: World;
  private readonly listeners = new Set<WorldListener>();
  private readonly channel = new BroadcastChannel(CHANNEL);

  constructor(scenario: Scenario, options: { reseed?: boolean } = {}) {
    const now = Date.now();
    const saved = options.reseed ? null : readSaved();
    if (usable(saved, scenarioId(scenario), now)) {
      this.world = saved;
    } else {
      this.world = seedWorld(scenario, now);
      this.publish();
    }
    this.channel.onmessage = (event: MessageEvent<WorldMessage>) => {
      if (event.data?.type === 'world') this.receive(event.data.world);
    };
  }

  get(): World {
    return this.world;
  }

  subscribe(listener: WorldListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Apply a mutation locally and to every other surface in this scenario. */
  commit(slices: Slice[], mutate: (draft: World) => void): World {
    const prev = this.world;
    const next = structuredClone(prev);
    mutate(next);
    next.rev = prev.rev + 1;
    for (const slice of slices) next.revs[slice] = prev.revs[slice] + 1;
    this.world = next;
    this.publish();
    this.notify(prev, new Set(slices));
    return next;
  }

  /** Throw the session away and start again from the scenario's seed. */
  reseed(scenario: Scenario): World {
    const prev = this.world;
    this.world = seedWorld(scenario, Date.now());
    this.publish();
    this.notify(prev, new Set(SLICES));
    return this.world;
  }

  close(): void {
    this.channel.close();
    this.listeners.clear();
  }

  private receive(incoming: World): void {
    const mine = this.world;
    if (incoming.scenarioId !== mine.scenarioId) return;
    const sameSeed = incoming.id === mine.id;
    const newer = sameSeed ? incoming.rev > mine.rev : incoming.seedAt > mine.seedAt;
    if (!newer) return;
    this.world = incoming;
    const changed = sameSeed ? new Set(SLICES.filter((slice) => incoming.revs[slice] !== mine.revs[slice])) : new Set(SLICES);
    this.notify(mine, changed);
  }

  private publish(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.world));
    } catch {
      // Private mode / quota: live sync still works over the channel.
    }
    this.channel.postMessage({ type: 'world', world: this.world } satisfies WorldMessage);
  }

  private notify(prev: World, changed: ReadonlySet<Slice>): void {
    if (changed.size === 0) return;
    for (const listener of this.listeners) listener(this.world, prev, changed);
  }
}
