import { MIN, OWNER, T0, base } from './timerEdge';
import type { Op, Scenario, SeedRow } from './timerTypes';

/**
 * Rows exactly as every released agent wrote them (`git log -p -- packages/core/src/types.ts
 * packages/core/src/segments.ts`). `parseEntry` is `{...raw, revision, closeReason, pauseReason}`
 * and every later mutation is an object spread, so the stored key order and any unknown key
 * survive to the next `JSON.stringify` — and the `json = ?` guards of `mark*` compare THAT text.
 *
 *   v1  63eeba0  projectId/taskId, no larkTaskGuid
 *   v2  44a7b27  + larkTaskGuid after taskId
 *   v3  807e3df  projectId nullable (same layout)
 *   v4  ea99ad6  projectId/taskId removed
 *   v5  042198e  a v4 row rewritten by the new agent: the three new keys appended at the end
 *   v6  hand-shaped: scrambled order, a nested unknown key, an exotic number
 */
type Pair = [string, unknown];
export type ShapeName = 'v1' | 'v2' | 'v3' | 'v4' | 'v5' | 'v6' | 'v7';
export const SHAPES: ShapeName[] = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7'];

const seg = (id: string, endedAt: number | null) => ({ id: `seg_${id}`, kind: 'WORK', startedAt: T0 + 0.25, endedAt });

function pairs(shape: ShapeName, id: string, user: string, endedAt: number | null): Pair[] {
  const core = (): Pair[] => [['source', 'AUTO'], ['startedAt', T0 + 0.25], ['endedAt', endedAt], ['segments', [seg(id, endedAt)]]];
  const head: Pair[] = [['id', id], ['clientUuid', `client_${id}`], ['userId', user]];
  const closing: Pair[] = endedAt === null ? [] : [['closeReason', 'AGENT']];
  switch (shape) {
    case 'v1': return [...head, ['projectId', 'proj-1'], ['taskId', null], ...core()];
    case 'v2': return [...head, ['projectId', 'proj-1'], ['taskId', 'task-9'], ['larkTaskGuid', null], ...core()];
    case 'v3': return [...head, ['projectId', null], ['taskId', null], ['larkTaskGuid', 'guid-7'], ...core()];
    case 'v4': return [...head, ['larkTaskGuid', 'guid-7'], ...core()];
    case 'v5': return [...head, ['larkTaskGuid', null], ...core(), ['revision', 1], ['closeReason', endedAt === null ? null : 'AGENT'], ['pauseReason', null]];
    case 'v6': return [
      ['segments', [seg(id, endedAt)]], ['notes', { z: [1, { b: 1e21, a: 0.1 }], a: null, m: 'x' }], ['id', id], ['userId', user],
      ['clientUuid', `client_${id}`], ['source', 'AUTO'], ['startedAt', T0 + 0.25], ['endedAt', endedAt], ['revision', 3],
      ['larkTaskGuid', 'guid-6'], ['big', 1e21], ['pauseReason', null], ...closing,
    ];
    // Revision present but the two reasons missing, with an unknown key before the known ones.
    case 'v7': return [['legacyFlag', true], ...head, ['revision', 2], ...core()];
  }
}

/** The exact text of a stored row. */
export function historicalText(shape: ShapeName, id: string, user: string, endedAt: number | null): string {
  return `{${pairs(shape, id, user, endedAt).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',')}}`;
}

function row(shape: ShapeName, id: string, user: string, endedAt: number | null, owned: boolean): SeedRow {
  return {
    id, clientUuid: `client_${id}`, endedAt, synced: 0, syncState: 'pending_create',
    ownerUserId: owned ? OWNER.userId : null, ownerWorkspaceId: owned ? OWNER.workspaceId : null,
    acknowledgedRevision: null, acknowledgedHash: null, jsonText: historicalText(shape, id, user, endedAt),
  };
}

const ok: Op = { op: 'deliver', i: 0, spec: { kind: 'ok', hash: 'agent' } };
const adv = (ms: number): Op => ({ op: 'advance', ms });
const flush: Op = { op: 'flush', limit: null };

/**
 * Per shape and ownership: boot (claim), read, sync (create, then the `mark*` guards), every
 * kind of mutation, a stale acknowledgement, a claim by server proof, recovery.
 */
function lifecycle(): Op[] {
  return [
    { op: 'listToday', at: T0 + MIN }, flush, ok, ok, ok, { op: 'drain' },
    { op: 'claimMatched', pairs: [{ id: 'c', clientUuid: 'client_c' }] }, flush, ok, { op: 'drain' },
    adv(MIN), { op: 'pause' }, ok, flush, ok, { op: 'resume' }, ok, adv(MIN), { op: 'heartbeat' },
    { op: 'pauseForPermission', ms: 5 }, { op: 'pauseForPermission', ms: 0 }, ok, { op: 'resume' }, adv(MIN),
    { op: 'pauseForIdle', ms: 1000 }, { op: 'resume' }, ok, { op: 'stop' }, ok, { op: 'drain' }, flush, { op: 'drain' },
    { op: 'listToday', at: T0 + 10 * MIN },
  ];
}

export function historyScenarios(): Scenario[] {
  const out: Scenario[] = [];
  for (const shape of SHAPES) {
    for (const owned of [false, true]) {
      const rows = [row(shape, 'o', 'user-1', null, owned), row(shape, 'u', 'user-1', T0 + MIN + 0.5, owned), row(shape, 'c', owned ? 'user-1' : 'self', T0 + MIN + 0.5, owned)];
      out.push({
        name: `hist-${shape}-${owned ? 'owned' : 'unowned-claimed'}-lifecycle`,
        setup: base({ claimLegacy: !owned, seedRows: rows }),
        ops: lifecycle(),
      });
    }
  }
  // The recovery, finalization and away paths rewrite the open row from the parsed object too.
  for (const shape of ['v1', 'v5', 'v6'] as const) {
    const rows = [row(shape, 'o', 'user-1', null, true)];
    for (const [name, ops] of [
      ['recover', [{ op: 'recover', at: T0 + 5 * MIN }, flush, ok, { op: 'drain' }]],
      ['finalize', [{ op: 'finalize', entry: 'open', at: T0 + 3 * MIN }, flush, ok, { op: 'drain' }]],
      ['switch', [{ op: 'start', guid: 'brand-new' }, ok, ok, { op: 'drain' }, flush, { op: 'drain' }]],
      ['away', [{ op: 'prepareForAway', reason: 'lock', ms: 1000 }, ok, { op: 'drain' }, flush, { op: 'drain' }]],
    ] as Array<[string, Op[]]>) {
      out.push({ name: `hist-${shape}-owned-${name}`, setup: base({ seedRows: rows }), ops });
    }
  }
  return out;
}
