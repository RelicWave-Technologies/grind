/**
 * The shape of a timer scenario: the `input` recorded in the fixture and
 * replayed by the Rust test, and the per-step record the legacy TypeScript
 * produced (the `output`).
 */
export interface Owner {
  userId: string;
  workspaceId: string;
}

export type BusinessDaySpec =
  | { kind: 'utc' }
  | { kind: 'fixed'; start: number; end: number }
  | { kind: 'none' }
  | { kind: 'offset'; offsetMs: number };

export type LedgerMode = 'OFF' | 'SHADOW' | 'VISIBLE';

/** A row inserted straight into `local_entries` (a legacy or foreign row). */
export interface SeedRow {
  id: string;
  clientUuid: string;
  endedAt: number | null;
  synced: 0 | 1;
  syncState: 'pending_create' | 'pending_update' | 'synced' | null;
  ownerUserId: string | null;
  ownerWorkspaceId: string | null;
  acknowledgedRevision: number | null;
  acknowledgedHash: string | null;
  /** The exact text of the `json` column. */
  jsonText: string;
}

export interface Setup {
  /** First monotonic reading (`performance.now()`), fractional. */
  mono0: number;
  /** True wall time at start; the device clock reads `true + skew`. */
  true0: number;
  skew: number;
  /** Added to the monotonic clock AFTER every read: catches a differing clock-read sequence. */
  perCall: number;
  owner: Owner | null;
  /** Call `bindOwner(owner, claimLegacy)` before the first op. */
  bind: boolean;
  claimLegacy: boolean;
  /** Create the pre-migration tables (and seed through them) before the store opens. */
  legacySchema: boolean;
  seedRows: SeedRow[];
  businessDay: BusinessDaySpec;
  mode: LedgerMode;
  idStart: number;
}

export type Op = { op: string } & Record<string, unknown>;

export interface Scenario {
  name: string;
  setup: Setup;
  ops: Op[];
}

/** A scripted reply to one queued request. */
export type DeliverySpec =
  | { kind: 'ok'; hash: 'server' | 'agent' | 'zeros' | 'short'; disposition?: string; correction?: string | null; revDelta?: number }
  | { kind: 'http'; status: number; body: string }
  | { kind: 'neterr' }
  | { kind: 'malformed'; variant: number };

/** What was actually delivered, recorded so the Rust replay needs no server model. */
export type Delivery =
  | { id: number; resolve: string }
  | { id: number; rejectHttp: { status: number; body: string } }
  | { id: number; rejectError: string };

export interface RowDump {
  rowid: number;
  id: string;
  client_uuid: string;
  ended_at: number | null;
  ended_at_type: string;
  synced: number;
  sync_state: string;
  owner_user_id: string | null;
  owner_workspace_id: string | null;
  acknowledged_revision: number | null;
  acknowledged_revision_type: string;
  acknowledged_hash: string | null;
  json: string;
}

export interface CallRecord {
  kind: string;
  path: string;
  method: string;
  timeoutMs: number | null;
  body: string;
}

export interface Settled {
  op: number;
  result: { ok: unknown } | { error: string };
}

export interface StepRecord {
  i: number;
  settled: Settled[];
  status: unknown;
  calls: CallRecord[];
  deliveries?: Delivery[];
  snapshot?: unknown;
  listener: number;
  pending: number;
  inflight: number;
  entries?: RowDump[];
  meta?: Array<{ key: string; value: string }>;
  cache?: unknown;
}
