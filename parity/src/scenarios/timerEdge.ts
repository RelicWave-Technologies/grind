import type { BusinessDaySpec, Op, Scenario, SeedRow, Setup } from './timerTypes';

export const MIN = 60_000;
export const DAY = 86_400_000;
export const OWNER = { userId: 'user-1', workspaceId: 'ws-1' };
export const T0 = 1_700_000_000_000;

export function base(over: Partial<Setup> = {}): Setup {
  return {
    mono0: 5000.25,
    true0: T0 + 0.5,
    skew: 0,
    perCall: 0,
    owner: OWNER,
    bind: true,
    claimLegacy: false,
    legacySchema: false,
    seedRows: [],
    businessDay: { kind: 'utc' },
    mode: 'VISIBLE',
    idStart: 0,
    ...over,
  };
}

const sc = (name: string, ops: Op[], over: Partial<Setup> = {}): Scenario => ({ name, setup: base(over), ops });

const start = (guid: string | null = null): Op => ({ op: 'start', guid });
const adv = (ms: number): Op => ({ op: 'advance', ms });
const ok = (hash: 'server' | 'agent' | 'zeros' | 'short' = 'agent', extra: Record<string, unknown> = {}): Op => ({
  op: 'deliver', i: 0, spec: { kind: 'ok', hash, ...extra },
});
const http = (status: number): Op => ({ op: 'deliver', i: 0, spec: { kind: 'http', status, body: `{"error":${status}}` } });
const neterr: Op = { op: 'deliver', i: 0, spec: { kind: 'neterr' } };
const drain: Op = { op: 'drain' };
const flush = (limit: number | 'inf' | null = null): Op => ({ op: 'flush', limit });

/** A stored entry as the Electron agent would have written it. */
export function entryText(id: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id, clientUuid: `client_${id}`, userId: 'user-1', larkTaskGuid: null, source: 'AUTO', revision: 1,
    startedAt: T0 + 0.25, endedAt: null, pauseReason: null, closeReason: null,
    segments: [{ id: `seg_${id}`, kind: 'WORK', startedAt: T0 + 0.25, endedAt: null }],
    ...over,
  });
}

export function seedRow(id: string, over: Partial<SeedRow> = {}, entry: Record<string, unknown> = {}): SeedRow {
  const text = entryText(id, entry);
  const parsed = JSON.parse(text) as { endedAt: number | null };
  return {
    id, clientUuid: `client_${id}`, endedAt: parsed.endedAt, synced: 0, syncState: 'pending_create',
    ownerUserId: null, ownerWorkspaceId: null, acknowledgedRevision: null, acknowledgedHash: null, jsonText: text, ...over,
  };
}

const closed = (id: string, endedAt: number): Record<string, unknown> => ({
  endedAt, closeReason: 'AGENT', revision: 2,
  segments: [{ id: `seg_${id}`, kind: 'WORK', startedAt: T0 + 0.25, endedAt }],
});

const KOLKATA: BusinessDaySpec = { kind: 'offset', offsetMs: 19_800_000 };
const away = (reason: string, entryId: string, at: number): Op => ({
  op: 'sql',
  stmt: "INSERT INTO timer_meta (key, value) VALUES ('ws-1:user-1:away_state', ?)",
  params: [JSON.stringify({ reason, entryId, awayStartedAt: at, observedAt: at + 1000.5 })],
});

/** One scenario per SC item of inventory section 2.2-2.4, plus the cross-cutting rules X1-X5. */
export function edgeScenarios(): Scenario[] {
  const windowDay = { start: T0 - (T0 % DAY), end: T0 - (T0 % DAY) + DAY };
  return [
    // SC-14 start
    sc('sc14-start-new-then-same-task-is-noop', [start('a'), ok('agent'), adv(3 * MIN + 0.75), start('a'), drain]),
    sc('sc14-start-switch-task-two-concurrent-syncs', [start('a'), drain, adv(10 * MIN + 0.125), start('b'), ok('server'), ok('zeros'), drain, adv(MIN), { op: 'listToday', at: T0 + 12 * MIN }]),
    sc('sc14-start-null-guid-then-task', [start(null), adv(MIN), start('t'), drain]),
    sc('sc14-start-guard-denied-mutates-nothing', [{ op: 'guard', mode: 'deny' }, start('a'), { op: 'guard', mode: 'allow' }, start('a')]),
    sc('sc14-start-no-owner', [start('a'), { op: 'bind', owner: null, claim: false }, start('a')], { owner: null, bind: true }),
    sc('sc14-switch-backwards-clock-segment-error', [start('a'), drain, { op: 'tracking', active: false }, { op: 'noteServerTime', offset: -10 * MIN, rtt: 0 }, start('b'), { op: 'pause' }]),
    sc('sc14-switch-rolls-back-on-client-uuid-collision', [start('a'), drain, adv(MIN), { op: 'ids', set: 0 }, start('b')]),
    // SC-15..17
    sc('sc15-stop-closes-entry-and-noop-when-idle', [stop(), start('a'), adv(5 * MIN + 0.3), stop(), stop(), drain]),
    sc('sc16-pause-then-resume-cycle', [start('a'), adv(5 * MIN), { op: 'pause' }, { op: 'pause' }, adv(MIN), { op: 'resume' }, { op: 'resume' }, drain]),
    sc('sc17-resume-blocked-by-guard-until-ready', [start('a'), { op: 'pauseForPermission', ms: 0 }, { op: 'guard', mode: 'deny' }, { op: 'resume' }, { op: 'guard', mode: 'allow' }, { op: 'resume' }]),
    sc('sc17-resume-guard-held-while-stop-runs', [start('a'), drain, { op: 'pause' }, { op: 'guard', mode: 'hold' }, { op: 'resume' }, adv(MIN), stop(), { op: 'releaseGuard', deny: false }, drain]),
    sc('sc17-resume-guard-held-while-restarted', [start('a'), { op: 'pause' }, { op: 'guard', mode: 'hold' }, { op: 'resume' }, { op: 'guard', mode: 'allow' }, stop(), start('b'), { op: 'releaseGuard', deny: false }]),
    sc('sc17-resume-from-idle-uses-later-of-at-and-now', [start('a'), adv(MIN), { op: 'pauseForIdle', ms: 0 }, adv(5 * MIN), { op: 'resumeFromIdle', at: T0 + 100 * MIN }, adv(MIN), { op: 'pauseForIdle', ms: 0 }, { op: 'resumeFromIdle', at: T0 }]),
    sc('sc17-double-resume-both-pass-guard', [start('a'), { op: 'pause' }, { op: 'guard', mode: 'hold' }, { op: 'resume' }, { op: 'resume' }, { op: 'releaseGuard', deny: false }, { op: 'releaseGuard', deny: false }]),
    // SC-18 / 19
    sc('sc18-pause-for-idle-clamps-to-segment-start', [start('a'), adv(2 * MIN), { op: 'pauseForIdle', ms: 60 * MIN }, { op: 'pauseForIdle', ms: 0 }]),
    sc('sc18-pause-for-idle-negative-and-fractional', [start('a'), adv(10 * MIN), { op: 'pauseForIdle', ms: -5000 }, adv(1), { op: 'resume' }, adv(10 * MIN), { op: 'pauseForIdle', ms: 4 * MIN + 0.5 }]),
    sc('sc19-pause-for-permission-all-three-branches', [{ op: 'pauseForPermission', ms: 5 }, start('a'), adv(5 * MIN), { op: 'pauseForPermission', ms: 7 * MIN }, { op: 'pauseForPermission', ms: 0 }, { op: 'pause' }, { op: 'resume' }, { op: 'pause' }, { op: 'pauseForPermission', ms: 0 }, drain]),
    // SC-20 / 21 / 22
    sc('sc20-prepare-for-quit-open-paused-idle', [{ op: 'prepareForQuit', reason: 'quit' }, start('a'), adv(9 * MIN), { op: 'prepareForQuit', reason: 'update' }, start('b'), { op: 'pauseForIdle', ms: 0 }, adv(20 * MIN), { op: 'prepareForQuit', reason: 'shutdown' }, drain]),
    sc('sc20-prepare-for-quit-clears-stale-intent', [{ op: 'sql', stmt: "INSERT INTO timer_meta (key, value) VALUES ('ws-1:user-1:exit_intent', ?)", params: ['{"reason":"quit","entryId":"old","observedAt":1}'] }, { op: 'prepareForQuit', reason: 'quit' }]),
    sc('sc21-prepare-for-away-running-and-paused', [start('a'), adv(5 * MIN), { op: 'prepareForAway', reason: 'suspend', ms: 0 }, start('b'), { op: 'pauseForIdle', ms: 0 }, adv(20 * MIN), { op: 'prepareForAway', reason: 'lock', ms: 3 * MIN }, drain]),
    sc('sc21-prepare-for-away-wrong-frame-duration-collapses', [start('a'), adv(10 * MIN), { op: 'pauseForIdle', ms: 60 * MIN }, { op: 'prepareForAway', reason: 'suspend', ms: 5 * MIN }], { skew: 5 * MIN }),
    sc('sc21-prepare-for-away-idle-clears-stale-state', [away('suspend', 'old', T0), { op: 'prepareForAway', reason: 'suspend', ms: 0 }]),
    sc('sc22-recover-closes-at-last-liveness', [start('a'), adv(5 * MIN), { op: 'heartbeat' }, adv(60 * MIN), { op: 'lastLiveness' }, { op: 'recover', at: T0 + 5 * MIN }, { op: 'recoveryNotice' }, drain]),
    sc('sc22-recover-never-before-latest-segment', [start('a'), adv(10 * MIN), { op: 'pauseForIdle', ms: 0 }, { op: 'recover', at: T0 + 5 * MIN }, { op: 'dismissNotice' }, { op: 'recoveryNotice' }]),
    sc('sc22-recover-nothing-open-clears-intent', [{ op: 'recover', at: T0 }]),
    sc('sc22-recover-away-closes-the-away-entry', [start('a'), adv(8 * MIN), away('suspend', 'ID00000001', T0 + 8 * MIN), { op: 'recoverAway' }, drain]),
    sc('sc22-recover-away-leaves-a-different-open-entry-open', [start('a'), adv(MIN), away('lock', 'some-other-entry', T0 + MIN), { op: 'recoverAway' }, { op: 'recoverAway' }]),
    sc('sc22-recover-away-keeps-existing-notice-for-closed-entry', [start('a'), adv(MIN), stop(), { op: 'recover', at: T0 }, away('lock', 'ID00000001', T0 + MIN), { op: 'recoverAway' }, { op: 'recoveryNotice' }]),
    // SC-23 / 24 / 25 / 26 / 27
    sc('sc23-accept-server-finalization', [start('a'), adv(2 * MIN), { op: 'finalize', entry: 'open', at: T0 + MIN + 0.5 }, { op: 'recoveryNotice' }, drain, { op: 'finalize', entry: 'open', at: T0 }]),
    sc('sc23-finalization-boundary-before-start-and-paused-open', [start('a'), adv(2 * MIN), { op: 'pauseForIdle', ms: 0 }, { op: 'finalize', entry: 'someone-else', at: T0 }, { op: 'finalize', entry: 'open', at: T0 - 5 * MIN }]),
    sc('sc24-heartbeat-liveness-and-garbage-values', [{ op: 'heartbeat' }, start('a'), adv(42_000), { op: 'heartbeat' }, { op: 'lastLiveness' }, { op: 'sql', stmt: "UPDATE timer_meta SET value = 'abc' WHERE key LIKE '%liveness'", params: [] }, { op: 'lastLiveness' }, { op: 'sql', stmt: "UPDATE timer_meta SET value = ' 12 ' WHERE key LIKE '%liveness'", params: [] }, { op: 'lastLiveness' }, { op: 'sql', stmt: "UPDATE timer_meta SET value = '' WHERE key LIKE '%liveness'", params: [] }, { op: 'lastLiveness' }, { op: 'sql', stmt: "UPDATE timer_meta SET value = '0x10' WHERE key LIKE '%liveness'", params: [] }, { op: 'lastLiveness' }]),
    sc('sc25-status-business-day-unavailable-is-zero', [start('a'), adv(5 * MIN), { op: 'listToday', at: T0 }, { op: 'workedByTask', at: null }], { businessDay: { kind: 'none' } }),
    sc('sc25-status-modes-off-shadow-visible-with-snapshot', [start('a'), adv(5 * MIN), { op: 'snapshot', mods: ['copy', 'older'], manual: true, extraAuto: true, window: windowDay, serverTimeOffset: 10 * MIN }, { op: 'mode', mode: 'OFF' }, { op: 'diagnostics', at: null }, { op: 'mode', mode: 'SHADOW' }, { op: 'diagnostics', at: T0 + 6 * MIN }, { op: 'mode', mode: 'VISIBLE' }, { op: 'listToday', at: T0 + 6 * MIN }, { op: 'workedByTask', at: T0 + 6 * MIN }], { businessDay: { kind: 'fixed', ...windowDay } }),
    sc('sc26-kolkata-midnight-split', [start('overnight'), adv(10 * MIN), { op: 'listToday', at: T0 + 10 * MIN }, { op: 'workedByTask', at: null }], { businessDay: KOLKATA, true0: Date.parse('2026-07-14T18:25:00.000Z') + 0.25 }),
    sc('sc26-snapshot-owner-mismatch-and-manual-rows', [start('a'), { op: 'snapshot', mods: ['otherUser'], manual: false, extraAuto: false, window: windowDay, serverTimeOffset: 0 }, { op: 'snapshot', mods: ['closed', 'newer', 'skip'], manual: true, extraAuto: true, window: windowDay, serverTimeOffset: 2 * MIN }, { op: 'workedByTask', at: null }], { businessDay: { kind: 'fixed', ...windowDay } }),
    sc('sc27-corrupt-cache-reads-as-empty', [start('a'), { op: 'snapshot', mods: ['copy'], manual: true, extraAuto: false, window: windowDay, serverTimeOffset: MIN }, { op: 'sql', stmt: "UPDATE server_entry_cache SET canonical_json = 'not-json'", params: [] }, adv(MIN), { op: 'listToday', at: T0 + MIN }, { op: 'sql', stmt: "UPDATE server_entry_cache SET effective_json = ''", params: [] }], { businessDay: { kind: 'fixed', ...windowDay } }),
    // SC-28 skewed device clock
    sc('sc28-device-ahead-idle-and-permission-pauses', [start('a'), adv(10 * MIN), { op: 'pauseForIdle', ms: 5 * MIN }, { op: 'resume' }, adv(MIN), { op: 'pauseForPermission', ms: 6000 }], { skew: -5 * MIN }),
    // SC-30 acknowledge
    sc('sc30-acknowledge-exact-hash-marks-synced', [start('a'), ok('agent'), adv(MIN), stop(), ok('agent'), drain]),
    sc('sc30-acknowledge-server-hash-never-matches-fractional', [start('a'), ok('server'), adv(MIN), stop(), ok('server'), drain, flush(), drain]),
    sc('sc30-acknowledge-corrections-and-dispositions', [start('a'), ok('zeros', { disposition: 'STALE' }), adv(MIN), { op: 'pause' }, ok('zeros', { correction: 'LEASE_FINALIZED' }), { op: 'resume' }, ok('zeros', { disposition: 'FINALIZED', revDelta: 1 }), { op: 'pause' }, ok('zeros', { disposition: 'FINALIZED', revDelta: -1 }), drain]),
    sc('sc30-clock-clamp-notice-uses-ended-at-or-server-time', [start('a'), ok('agent', { correction: 'CLOCK_CLAMP' }), adv(MIN), stop(), ok('agent', { correction: 'CLOCK_CLAMP' }), { op: 'recoveryNotice' }, drain]),
    sc('sc30-malformed-and-short-hash-receipts-are-failures', [start('a'), { op: 'deliver', i: 0, spec: { kind: 'malformed', variant: 0 } }, flush(), { op: 'deliver', i: 0, spec: { kind: 'malformed', variant: 1 } }, flush(), ok('short'), flush(), { op: 'deliver', i: 0, spec: { kind: 'malformed', variant: 2 } }, { op: 'deliver', i: 0, spec: { kind: 'malformed', variant: 3 } }, drain]),
    // SC-31 sync paths
    sc('sc31-create-fails-then-flush-retries', [start('a'), neterr, flush(), ok('zeros'), drain]),
    sc('sc31-update-404-downgrades-to-create', [start('a'), ok('zeros'), drain, adv(5 * MIN), { op: 'pauseForIdle', ms: 0 }, http(404), drain, ok('agent'), drain]),
    sc('sc31-update-500-and-create-500-stay-pending', [start('a'), http(500), flush(), http(503), adv(MIN), stop(), neterr, drain]),
    sc('sc31-stale-create-response-after-newer-mutation', [start('a'), adv(MIN), { op: 'pause' }, ok('zeros'), ok('agent'), drain, adv(MIN), { op: 'resume' }, ok('agent'), drain]),
    sc('sc31-stale-update-response-after-newer-mutation', [start('a'), ok('zeros'), drain, adv(MIN), { op: 'pause' }, adv(1), { op: 'resume' }, { op: 'deliver', i: 0, spec: { kind: 'ok', hash: 'agent' } }, drain]),
    sc('sc31-owner-switch-with-syncs-in-flight', [start('a'), adv(MIN), { op: 'bind', owner: { userId: 'user-2', workspaceId: 'ws-1' }, claim: false }, drain, { op: 'bind', owner: OWNER, claim: false }, flush(), drain]),
    // SC-32 flush
    sc('sc32-flush-limit-and-exact-limit', [start('a'), neterr, stop(), neterr, start('b'), neterr, stop(), neterr, start('c'), neterr, stop(), neterr, flush(2), drain, drain, flush(2), drain, flush('inf'), drain]),
    sc('sc32-flush-settles-background-syncs-first', [start('a'), flush(), ok('agent'), ok('agent'), drain, flush(0), drain]),
    // SC-33 memo
    sc('sc33-switch-does-not-bump-the-epoch-memo-stays', [start('a'), { op: 'listToday', at: T0 }, adv(MIN), start('b'), adv(100), { op: 'listToday', at: T0 }, adv(11_000), { op: 'listToday', at: T0 }, drain]),
    sc('sc33-owner-switch-keeps-previous-owners-memo', [start('a'), adv(MIN), { op: 'listToday', at: T0 }, { op: 'bind', owner: { userId: 'user-2', workspaceId: 'ws-1' }, claim: false }, { op: 'listToday', at: T0 }, adv(12_000), { op: 'listToday', at: T0 }]),
    // SC-36..41 store
    sc('sc36-upsert-owner-mismatch-and-foreign-row', [start('a'), { op: 'sql', stmt: "UPDATE local_entries SET owner_workspace_id = 'ws-other'", params: [] }, { op: 'pause' }, { op: 'sql', stmt: "UPDATE local_entries SET owner_workspace_id = 'ws-1', owner_user_id = 'user-2'", params: [] }, { op: 'pause' }]),
    sc('sc37-ack-kept-only-when-json-unchanged', [start('a'), ok('agent'), adv(MIN), { op: 'heartbeat' }, { op: 'pause' }, { op: 'pause' }, ok('agent'), drain]),
    sc('sc38-ordering-two-open-rows-newest-wins', [{ op: 'bind', owner: OWNER, claim: false }, { op: 'listToday', at: T0 }], { seedRows: [
      seedRow('older', { ownerUserId: 'user-1', ownerWorkspaceId: 'ws-1' }), seedRow('newer', { ownerUserId: 'user-1', ownerWorkspaceId: 'ws-1' }, { startedAt: T0 + 5, segments: [{ id: 'seg_newer', kind: 'WORK', startedAt: T0 + 5, endedAt: null }] }),
    ] }),
    sc('sc39-claim-unowned-only-rows-naming-the-user', [{ op: 'heartbeat' }, { op: 'finalize', entry: 'open', at: T0 + 3 * MIN }, flush(), drain, { op: 'claimMatched', pairs: [{ id: 'proven', clientUuid: 'client_proven' }, { id: 'proven2', clientUuid: 'wrong' }] }, flush(), drain], {
      bind: true, claimLegacy: true,
      seedRows: [
        seedRow('mine'), seedRow('self_row', {}, { userId: 'self' }),
        seedRow('proven', {}, { userId: 'self', ...closed('proven', T0 + MIN) }), seedRow('proven2', {}, { userId: 'self', ...closed('proven2', T0 + MIN) }),
      ],
    }),
    sc('sc39-legacy-schema-migration-and-meta-carry-over', [{ op: 'lastLiveness' }, { op: 'recoveryNotice' }, flush(), drain], {
      legacySchema: true, claimLegacy: true,
      seedRows: [seedRow('old_synced', { synced: 1 }, closed('old_synced', T0 + MIN)), seedRow('old_unsynced')],
    }),
    sc('sc41-parse-normalises-odd-legacy-rows', [flush(), drain], {
      claimLegacy: true,
      seedRows: [
        seedRow('no_revision', { ownerUserId: 'user-1', ownerWorkspaceId: 'ws-1' }, { revision: undefined }),
        seedRow('neg_rev', { ownerUserId: 'user-1', ownerWorkspaceId: 'ws-1' }, { revision: -3, closeReason: 'WHATEVER', pauseReason: 'NAP' }),
        seedRow('frac_rev', { ownerUserId: 'user-1', ownerWorkspaceId: 'ws-1' }, { revision: 2.5, pauseReason: 'IDLE', closeReason: 'AGENT_RECOVERY', ...closed('frac_rev', T0 + 3) }),
      ],
    }),
    // SC-43 bodies / X1 / X3
    sc('x1-fractional-stamps-in-bodies-and-columns', [start('x'), adv(1234.56789), { op: 'pauseForIdle', ms: 0.001 }, adv(0.3), { op: 'resume' }, adv(7.7), stop(), drain], { mono0: 123456.789012, true0: 1791133383891.2627, perCall: 0.013 }),
    sc('x3-revision-bumps-follow-the-core-rules', [start('x'), { op: 'pause' }, { op: 'resume' }, { op: 'pauseForPermission', ms: 0 }, { op: 'pauseForPermission', ms: 0 }, { op: 'resume' }, stop(), { op: 'recover', at: T0 }, drain]),
    sc('x4-background-completion-after-quit', [start('a'), adv(MIN), { op: 'prepareForQuit', reason: 'quit' }, ok('zeros'), ok('agent'), flush('inf'), drain]),
    // listener / ids
    sc('listener-failure-never-fails-a-mutation', [{ op: 'listener', throws: true }, start('a'), { op: 'pause' }, { op: 'listener', throws: false }, { op: 'resume' }, drain]),
    sc('dead-code-meeting-and-discard-away', [start('a'), adv(5 * MIN), { op: 'beginMeeting', at: T0 + 5 * MIN }, { op: 'beginMeeting', at: T0 + 5 * MIN }, adv(20 * MIN), { op: 'endMeeting', at: T0 + 25 * MIN }, { op: 'endMeeting', at: T0 + 25 * MIN }, { op: 'discardAway', start: T0 + 26 * MIN, resume: T0 + 56 * MIN }, { op: 'discardAway', start: T0, resume: T0 + 500 }, drain]),
    // server clock
    sc('sc48-server-clock-step-held-while-tracking-then-applied', [{ op: 'noteServerTime', offset: 10 * MIN, rtt: 6000 }, start('a'), { op: 'tracking', active: true }, { op: 'suspend', ms: 9 * MIN }, { op: 'noteServerTime', offset: 0, rtt: 250 }, adv(MIN), { op: 'noteServerTime', offset: 0, rtt: 0 }, adv(MIN), stop(), { op: 'tracking', active: false }, start('b'), drain]),
    sc('sc48-server-clock-jitter-garbage-and-device-jump', [{ op: 'noteServerTime', offset: 0, rtt: 0 }, { op: 'noteServerTime', offset: 200, rtt: 0 }, { op: 'noteRaw', iso: 'not-a-date', started: 1, received: 2 }, { op: 'noteRaw', iso: '2026-01-01T00:00:00.000Z', started: null, received: 2 }, { op: 'jumpDevice', ms: 3 * 60 * MIN }, start('a'), adv(MIN), { op: 'tracking', active: true }, { op: 'tracking', active: true }, { op: 'tracking', active: false }, drain], { skew: 12 * MIN }),
    // D: interleavings at the known yield points (guard pending; background sync after a newer mutation)
    sc('d-start-guard-held-two-concurrent-starts', [{ op: 'guard', mode: 'hold' }, start('a'), start('b'), { op: 'guard', mode: 'allow' }, { op: 'releaseGuard', deny: false }, adv(MIN), { op: 'releaseGuard', deny: false }, drain]),
    sc('d-start-guard-held-then-guard-denies-on-release', [{ op: 'guard', mode: 'hold' }, start('a'), { op: 'releaseGuard', deny: true }, start('b'), { op: 'guard', mode: 'allow' }, start('b'), drain]),
    sc('d-start-held-while-quit-and-away-run', [start('a'), { op: 'guard', mode: 'hold' }, start('b'), { op: 'prepareForQuit', reason: 'quit' }, { op: 'prepareForAway', reason: 'lock', ms: 0 }, { op: 'releaseGuard', deny: false }, drain]),
    sc('d-resume-held-then-recover-closes-the-entry', [start('a'), { op: 'pause' }, { op: 'guard', mode: 'hold' }, { op: 'resume' }, { op: 'recover', at: T0 + MIN }, { op: 'releaseGuard', deny: false }, drain]),
    sc('d-create-answered-after-stop-then-update-answered', [start('a'), adv(MIN), stop(), { op: 'deliver', i: 0, spec: { kind: 'ok', hash: 'zeros' } }, { op: 'deliver', i: 0, spec: { kind: 'ok', hash: 'agent' } }, drain, flush(), drain]),
    sc('d-answers-out-of-order-across-two-entries', [start('a'), adv(MIN), start('b'), adv(MIN), stop(), { op: 'deliver', i: 2, spec: { kind: 'ok', hash: 'agent' } }, { op: 'deliver', i: 1, spec: { kind: 'http', status: 404, body: '{}' } }, { op: 'deliver', i: 0, spec: { kind: 'ok', hash: 'zeros' } }, drain, flush(), drain]),
    sc('d-two-flushes-in-flight-with-background-syncs', [start('a'), neterr, adv(MIN), stop(), neterr, flush(), flush(), ok('zeros'), ok('agent'), ok('agent'), drain, drain]),
    sc('d-flush-stale-snapshot-after-mutation', [start('a'), neterr, flush(), adv(MIN), { op: 'pause' }, ok('zeros'), ok('agent'), drain, flush(), drain]),
    sc('guard-held-while-prepare-for-away-runs', [{ op: 'guard', mode: 'hold' }, start('a'), { op: 'guard', mode: 'allow' }, start('b'), adv(MIN), { op: 'prepareForAway', reason: 'suspend', ms: 0 }, { op: 'releaseGuard', deny: false }, stop(), drain]),
  ];
}

function stop(): Op {
  return { op: 'stop' };
}
