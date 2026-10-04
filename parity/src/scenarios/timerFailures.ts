import { DAY, MIN, OWNER, T0, base, seedRow } from './timerEdge';
import type { Op, Scenario } from './timerTypes';

/**
 * Failures injected BETWEEN durable effects, which the interleaving scenarios never reach:
 * a SQLite write that fails halfway through an operation (a trigger raising ABORT, so both
 * stores see the same error text), a `mark*` that fails between the acknowledgement and the
 * next request, and a cache whose queries throw. The state left behind after each failure is
 * the contract (the exit intent that stays, the away state that stays, the entry closed in
 * the database but still open in memory), and so is the retry that follows.
 */
const sql = (stmt: string): Op => ({ op: 'sql', stmt, params: [] });
const trigger = (name: string, on: string, when: string, event = 'INSERT'): Op => sql(
  `CREATE TRIGGER ${name} BEFORE ${event} ON ${on} WHEN ${when} BEGIN SELECT RAISE(ABORT, 'injected: ${name}'); END`,
);
const drop = (name: string): Op => sql(`DROP TRIGGER ${name}`);
const start = (guid: string | null = null): Op => ({ op: 'start', guid });
const stop: Op = { op: 'stop' };
const adv = (ms: number): Op => ({ op: 'advance', ms });
const ok = (hash: 'server' | 'agent' | 'zeros' = 'agent'): Op => ({ op: 'deliver', i: 0, spec: { kind: 'ok', hash } });
const http = (status: number): Op => ({ op: 'deliver', i: 0, spec: { kind: 'http', status, body: `{"error":${status}}` } });
const neterr: Op = { op: 'deliver', i: 0, spec: { kind: 'neterr' } };
const flush: Op = { op: 'flush', limit: null };
const drain: Op = { op: 'drain' };

const CLOSING_INSERT = 'NEW.ended_at IS NOT NULL';
const OPEN_INSERT = 'NEW.ended_at IS NULL';
const NOTICE_INSERT = "NEW.key LIKE '%recovery_notice'";

const windowDay = { start: T0 - (T0 % DAY), end: T0 - (T0 % DAY) + DAY };
const fixedDay = { businessDay: { kind: 'fixed' as const, ...windowDay } };
const snapshot: Op = { op: 'snapshot', mods: ['copy'], manual: true, extraAuto: false, window: windowDay, serverTimeOffset: MIN };
const reads: Op[] = [{ op: 'listToday', at: T0 + MIN }, { op: 'workedByTask', at: null }, { op: 'diagnostics', at: null }];

export function failureScenarios(): Scenario[] {
  const sc = (name: string, ops: Op[], over: Parameters<typeof base>[0] = {}): Scenario => ({ name, setup: base(over), ops });
  return [
    // --- the cache's queries (not its JSON) throw -------------------------------------------
    sc('cache-meta-table-missing-throws-everywhere', [start('a'), snapshot, adv(MIN), sql('DROP TABLE server_snapshot_meta'), ...reads, { op: 'mode', mode: 'OFF' }, ...reads, { op: 'mode', mode: 'VISIBLE' }, start('b'), stop, drain], fixedDay),
    sc('cache-rows-table-missing-throws-after-a-valid-meta', [start('a'), snapshot, sql('DROP TABLE server_entry_cache'), ...reads, { op: 'pause' }, { op: 'resume' }, stop, drain], fixedDay),
    sc('cache-meta-table-missing-before-any-snapshot', [sql('DROP TABLE server_snapshot_meta'), start('a'), ...reads, snapshot, stop, drain], fixedDay),
    sc('cache-meta-day-end-not-a-number-reads-as-no-snapshot', [start('a'), snapshot, sql("UPDATE server_snapshot_meta SET day_end = 'later'"), ...reads, adv(MIN), stop], fixedDay),
    sc('cache-rows-unreadable-text-effective-json-falls-back-to-empty', [start('a'), snapshot, sql("UPDATE server_entry_cache SET effective_json = 'x'"), ...reads, sql("UPDATE server_entry_cache SET canonical_json = '{}'"), ...reads], fixedDay),
    // --- a write that fails halfway ---------------------------------------------------------
    sc('fail-write-on-first-start-then-retry', [trigger('t1', 'local_entries', 'NEW.id IS NOT NULL'), start('a'), { op: 'heartbeat' }, drop('t1'), start('a'), ok(), stop, ok(), drain]),
    sc('fail-second-upsert-of-a-task-switch-rolls-both-back', [start('a'), ok(), adv(MIN), trigger('t2', 'local_entries', OPEN_INSERT), start('b'), { op: 'pause' }, drop('t2'), start('b'), ok(), ok(), drain]),
    sc('fail-write-on-pause-keeps-the-open-entry-running', [start('a'), ok(), adv(MIN), trigger('t3', 'local_entries', OPEN_INSERT), { op: 'pause' }, { op: 'pauseForIdle', ms: 1000 }, { op: 'pauseForPermission', ms: 0 }, drop('t3'), { op: 'pause' }, ok(), { op: 'resume' }, drain]),
    sc('fail-write-on-resume-after-the-guard', [start('a'), ok(), { op: 'pause' }, ok(), trigger('t4', 'local_entries', OPEN_INSERT), { op: 'resume' }, drop('t4'), { op: 'resume' }, ok(), drain]),
    sc('fail-close-on-quit-leaves-the-exit-intent', [start('a'), ok(), adv(MIN), trigger('t5', 'local_entries', CLOSING_INSERT), { op: 'prepareForQuit', reason: 'quit' }, stop, drop('t5'), { op: 'prepareForQuit', reason: 'update' }, ok(), drain]),
    sc('fail-close-on-away-leaves-the-away-state-and-the-open-entry', [start('a'), ok(), adv(MIN), trigger('t6', 'local_entries', CLOSING_INSERT), { op: 'prepareForAway', reason: 'lock', ms: 0 }, { op: 'recoverAway' }, drop('t6'), { op: 'prepareForAway', reason: 'suspend', ms: 5 }, ok(), drain]),
    sc('fail-notice-write-after-the-away-close-already-landed', [start('a'), ok(), adv(MIN), trigger('t7', 'timer_meta', NOTICE_INSERT), { op: 'prepareForAway', reason: 'lock', ms: 0 }, { op: 'recoveryNotice' }, drop('t7'), { op: 'recoverAway' }, flush, ok(), drain]),
    sc('fail-notice-write-after-recovery-closed-the-entry', [start('a'), ok(), adv(MIN), { op: 'heartbeat' }, trigger('t8', 'timer_meta', NOTICE_INSERT), { op: 'recover', at: T0 + 30_000 }, { op: 'recover', at: T0 }, drop('t8'), { op: 'recover', at: T0 }, { op: 'recoveryNotice' }, flush, ok(), drain]),
    sc('fail-liveness-write', [start('a'), trigger('t9', 'timer_meta', "NEW.key LIKE '%liveness'"), { op: 'heartbeat' }, { op: 'lastLiveness' }, drop('t9'), { op: 'heartbeat' }, { op: 'lastLiveness' }, drain]),
    sc('fail-finalization-write-keeps-the-entry-open', [start('a'), ok(), adv(2 * MIN), trigger('t10', 'local_entries', CLOSING_INSERT), { op: 'finalize', entry: 'open', at: T0 + MIN }, drop('t10'), { op: 'finalize', entry: 'open', at: T0 + MIN }, drain]),
    // --- a mark* that fails between two requests --------------------------------------------
    sc('fail-mark-created-after-a-good-create-response', [trigger('t11', 'local_entries', "OLD.sync_state = 'pending_create' AND NEW.sync_state = 'pending_update'", 'UPDATE'), start('a'), ok('zeros'), flush, ok('zeros'), drop('t11'), flush, ok('zeros'), ok('agent'), drain]),
    sc('fail-mark-synced-after-an-exact-acknowledgement', [start('a'), ok('zeros'), trigger('t12', 'local_entries', "NEW.sync_state = 'synced'", 'UPDATE'), ok('agent'), flush, ok('agent'), drop('t12'), flush, ok('agent'), drain]),
    sc('fail-mark-synced-on-the-create-path', [trigger('t13', 'local_entries', "NEW.sync_state = 'synced'", 'UPDATE'), start('a'), ok('agent'), flush, ok('agent'), drop('t13'), flush, ok('agent'), drain]),
    sc('fail-mark-pending-create-after-a-404-in-the-background', [start('a'), ok('zeros'), trigger('t14', 'local_entries', "OLD.sync_state = 'pending_update' AND NEW.sync_state = 'pending_create'", 'UPDATE'), http(404), flush, http(404), drop('t14'), flush, http(404), ok('zeros'), drain]),
    sc('fail-mark-pending-create-after-a-404-inside-a-flush', [start('a'), ok('zeros'), ok('zeros'), adv(MIN), { op: 'pause' }, { op: 'drain' }, trigger('t15', 'local_entries', "OLD.sync_state = 'pending_update' AND NEW.sync_state = 'pending_create'", 'UPDATE'), adv(MIN), { op: 'resume' }, http(404), flush, http(404), drain]),
    sc('network-fails-between-the-create-and-the-update', [start('a'), ok('zeros'), neterr, flush, ok('zeros'), http(500), flush, ok('zeros'), http(404), flush, ok('zeros'), ok('agent'), drain]),
    sc('network-fails-after-the-update-was-marked-pending-create', [start('a'), ok('zeros'), http(404), neterr, flush, http(503), flush, ok('zeros'), ok('agent'), drain]),
    // --- claiming rows inside one transaction ----------------------------------------------
    {
      name: 'fail-claim-transaction-rolls-back-every-row',
      setup: base({ bind: false, claimLegacy: true, seedRows: [seedRow('first'), seedRow('second'), seedRow('third')] }),
      ops: [
        trigger('t16', 'local_entries', "NEW.id = 'second'", 'UPDATE'),
        { op: 'bind', owner: OWNER, claim: true }, { op: 'listToday', at: T0 }, { op: 'hasUnsynced' },
        drop('t16'),
        { op: 'bind', owner: OWNER, claim: true }, { op: 'listToday', at: T0 }, flush, ok(), ok(), ok(), drain,
      ],
    },
  ];
}
