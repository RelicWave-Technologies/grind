import { LarkTaskCache, type CachedLarkTask, type LarkTaskCacheOwner } from '../../../legacy/agent/src/main/services/larkTaskCache';
import type { FnSpec } from '../fixture';
import type { Rng } from '../prng';
import { T0, MIN, id } from './common';
import { runCase, lit, type StoreCase } from './storeDb';
import { count, maybeText, text } from './storeValues';
import { smallCount } from './seq';

const module = 'store';

type Op =
  | { op: 'replace'; owner: LarkTaskCacheOwner; tasks: CachedLarkTask[]; fetchedAt: number }
  | { op: 'list'; owner: LarkTaskCacheOwner }
  | { op: 'has'; owner: LarkTaskCacheOwner }
  | { op: 'reopen' }
  | { op: 'exec'; sql: string };

type Input = StoreCase<Op>;

const OWNERS: LarkTaskCacheOwner[] = [
  { userId: 'user-a', workspaceId: 'workspace-a' },
  { userId: 'user-b', workspaceId: 'workspace-a' },
  { userId: 'user-a', workspaceId: 'workspace-b' },
  { userId: 'é', workspaceId: "o'reilly" },
];

const GUIDS = ['task-a', 'task-b', 'task-c', 'task-d', 'Task-A', 'é', 'task-10', 'task-9', '', ' '];

/** A task in the key order the API writes (`apps/api/src/lark/tasks.ts`), with an optional `url` and extras. */
function genTask(rng: Rng, used: Set<string>): CachedLarkTask {
  let guid = rng.chance(0.2) ? id(rng) : rng.pick(GUIDS);
  if (rng.chance(0.85)) while (used.has(guid)) guid = `${guid}${rng.int(0, 99)}`;
  used.add(guid);
  const base: Record<string, unknown> = { guid, summary: text(rng), completed: rng.chance(0.3) };
  if (rng.chance(0.5)) base.url = `https://applink.larksuite.com/${rng.int(0, 99999)}?x=${text(rng).length}`;
  Object.assign(base, {
    due: rng.chance(0.5) ? null : T0 + rng.int(-100, 100) * MIN,
    createdAt: rng.chance(0.4) ? null : T0 - rng.int(0, 500) * MIN,
    creatorId: maybeText(rng),
    creatorName: maybeText(rng),
    loggedMs: count(rng),
    loggedTodayMs: count(rng),
    loggedTotalMs: count(rng),
  });
  if (rng.chance(0.1)) base.extraNote = rng.pick([1, 'x', null, true, { a: [1, 2] }]);
  return base as unknown as CachedLarkTask;
}

const validJson = (rng: Rng): string => JSON.stringify(genTask(rng, new Set()));

/** What a damaged cache row can look like. */
function damagedJson(rng: Rng): string {
  const good = JSON.parse(validJson(rng)) as Record<string, unknown>;
  return rng.pick([
    () => 'not json',
    () => '',
    () => 'null',
    () => '[]',
    () => '5',
    () => '"str"',
    () => '{}',
    () => '{"guid":"g"}',
    () => JSON.stringify({ ...good, guid: '' }),
    () => JSON.stringify({ ...good, guid: 7 }),
    () => JSON.stringify({ ...good, summary: null }),
    () => JSON.stringify({ ...good, completed: 'yes' }),
    () => JSON.stringify({ ...good, due: '5' }),
    () => JSON.stringify({ ...good, due: undefined }),
    () => JSON.stringify({ ...good, loggedMs: '1' }),
    () => JSON.stringify({ ...good, url: 42 }),
    () => JSON.stringify({ ...good, url: null }),
    () => JSON.stringify({ ...good, extra: { nested: [1, 2, 3] } }),
    () => `${JSON.stringify(good)} `,
    () => ` ${JSON.stringify(good)}`,
    () => JSON.stringify(good).slice(0, 20),
  ])();
}

function seedRowSql(rng: Rng, damaged: boolean): string {
  const owner = rng.pick(OWNERS);
  const json = damaged ? damagedJson(rng) : validJson(rng);
  const guid = rng.pick(GUIDS.slice(0, 6));
  const fetched = rng.chance(0.2) ? T0 + 0.5 : T0 + rng.int(0, 5) * MIN;
  return `INSERT OR REPLACE INTO lark_task_cache (owner_user_id, owner_workspace_id, guid, json, fetched_at) VALUES (${lit(owner.userId)}, ${lit(owner.workspaceId)}, ${lit(guid)}, ${lit(json)}, ${lit(fetched)})`;
}

const SCHEMA_DDL = `CREATE TABLE lark_task_cache (owner_user_id TEXT NOT NULL, owner_workspace_id TEXT NOT NULL, guid TEXT NOT NULL, json TEXT NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY (owner_user_id, owner_workspace_id, guid))`;

function genPre(rng: Rng): string[] {
  if (rng.chance(0.55)) return [];
  const rows = Array.from({ length: smallCount(rng, 1, 7) }, () => seedRowSql(rng, rng.chance(0.6)));
  return [SCHEMA_DDL, ...rows];
}

function genOp(rng: Rng): Op {
  const owner = (): LarkTaskCacheOwner => rng.pick(OWNERS);
  return rng.weighted<() => Op>([
    [() => {
      const used = new Set<string>();
      const fetchedAt = rng.weighted<number>([[T0 + rng.int(0, 3000) * MIN, 80], [T0 + 0.25, 10], [rng.pick([0, 1e300]), 10]]);
      return { op: 'replace', owner: owner(), tasks: Array.from({ length: smallCount(rng, 0, 6) }, () => genTask(rng, used)), fetchedAt };
    }, 38],
    [() => ({ op: 'list', owner: owner() }), 24],
    [() => ({ op: 'has', owner: owner() }), 12],
    [() => ({ op: 'reopen' }), 3],
    [() => ({ op: 'exec', sql: seedRowSql(rng, rng.chance(0.7)) }), 18],
    [() => ({ op: 'exec', sql: rng.pick(["UPDATE lark_task_cache SET json = 'oops' WHERE rowid % 2 = 0", 'DELETE FROM lark_task_cache']) }), 5],
  ])();
}

const KEY_ORDER = ['guid', 'summary', 'completed', 'url', 'due', 'createdAt', 'creatorId', 'creatorName', 'loggedMs', 'loggedTodayMs', 'loggedTotalMs'];

/** A task in the API's key order (`url` right after `completed`), whatever order the overrides come in. */
const task = (over: Record<string, unknown> = {}): CachedLarkTask => {
  const fields: Record<string, unknown> = {
    guid: 'task-a', summary: 'Offline-safe task', completed: false, due: null, createdAt: null, creatorId: null, creatorName: null, loggedMs: 0, loggedTodayMs: 0, loggedTotalMs: 0, ...over,
  };
  const ordered: Record<string, unknown> = {};
  for (const key of KEY_ORDER) if (fields[key] !== undefined) ordered[key] = fields[key];
  for (const key of Object.keys(fields)) if (!KEY_ORDER.includes(key)) ordered[key] = fields[key];
  return ordered as unknown as CachedLarkTask;
};

const spec: FnSpec<Input> = {
  crate: 'timo-store',
  module,
  fn: 'larkTaskCache',
  edge: () => [
    { pre: [], ops: [] },
    {
      pre: [],
      ops: [
        { op: 'replace', owner: OWNERS[0]!, tasks: [task()], fetchedAt: T0 }, { op: 'replace', owner: OWNERS[1]!, tasks: [task({ guid: 'task-b' })], fetchedAt: T0 },
        { op: 'list', owner: OWNERS[0]! }, { op: 'list', owner: OWNERS[1]! }, { op: 'has', owner: OWNERS[2]! },
        { op: 'replace', owner: OWNERS[0]!, tasks: [task({ guid: 'task-next', summary: 'New task' })], fetchedAt: T0 + 1 }, { op: 'list', owner: OWNERS[0]! },
      ],
    },
    { pre: [], ops: [{ op: 'replace', owner: OWNERS[0]!, tasks: [task(), task()], fetchedAt: T0 }, { op: 'has', owner: OWNERS[0]! }, { op: 'list', owner: OWNERS[0]! }] },
    { pre: [], ops: [{ op: 'replace', owner: OWNERS[3]!, tasks: [task({ summary: 'é 😀 "q"\n\\  ', url: 'https://x.test/?a=1&b=é', due: 1791133383891.2627, loggedMs: 0.1, loggedTodayMs: 1e21, loggedTotalMs: -0.5 })], fetchedAt: 1791133383891.2627 }, { op: 'list', owner: OWNERS[3]! }] },
    { pre: [], ops: [{ op: 'replace', owner: OWNERS[0]!, tasks: [task({ extraNote: { a: [1, 2] } })], fetchedAt: T0 }, { op: 'list', owner: OWNERS[0]! }] },
  ],
  random: (rng) => ({ pre: genPre(rng), ops: Array.from({ length: smallCount(rng, 1, 30) }, () => genOp(rng)) }),
  call: (input) =>
    runCase(
      input,
      (db) => new LarkTaskCache(db),
      (store, op) => {
        switch (op.op) {
          case 'replace': return store.replace(op.owner, op.tasks, op.fetchedAt);
          case 'list': return store.list(op.owner);
          case 'has': return store.has(op.owner);
          default: throw new Error(`unexpected op ${op.op}`);
        }
      },
    ),
};

export const specs: FnSpec<any>[] = [spec];
