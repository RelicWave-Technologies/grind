/**
 * The scenario runner, in a CHILD PROCESS of the generators. The scenarios patch
 * process-wide state (`Date.now`, `Math.random`, `fetch`, `node:crypto`,
 * `os.hostname`, `process.platform`) to make the real TypeScript deterministic;
 * in the parent, other generators run concurrently in the same process and see
 * (and are seen by) those patches. The child owns its globals: one JSON line in,
 * one JSON line out, scenarios one at a time.
 *
 * Run by `syncRemote.ts`; not an entry point of its own.
 */
import crypto from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { createInterface } from 'node:readline';
import { loadLegacy } from '../legacyStubs/register';
import { setEnv } from '../legacyStubs/syncEnv';
import { exclusive, resetSync, sync, type FetchCall } from '../legacyStubs/syncState';

const activitySync = await loadLegacy<{
  flushActivity: (store: unknown, isPending?: (id: string) => boolean) => Promise<number>;
}>('services/activity/sync.ts');
const auth = await loadLegacy<{
  startLarkLogin: () => Promise<void>;
  completeLarkLogin: (code: string) => Promise<boolean>;
  cancelLarkLogin: () => void;
  login: (email: string, password: string) => Promise<unknown>;
}>('services/auth.ts');
const up = await loadLegacy<{ uploadScreenshotsNow: (rows: unknown[]) => Promise<void> }>('services/capture/uploader.ts');
const api = await import('../legacyStubs/syncApi');

type Op =
  | { op: 'start'; now: number; openFails: boolean }
  | { op: 'complete'; now: number; code: string; response: unknown }
  | { op: 'cancel'; now: number }
  | { op: 'login'; now: number; email: string; password: string; hostname: string; platform: 'darwin' | 'win32' | 'linux'; response: unknown };
interface AuthInput { apiUrl: string; scheme: 'grind' | 'timo'; random: string[]; ops: Op[] }
interface Reply { status: number; body: string }
interface FlowInput {
  row: { id: string; timeEntryId: string | null; displayId: string; capturedAt: number; bytes: number; width: number; height: number; attempts: number };
  fileExists: boolean;
  sign: 'ok' | 'unauthorized' | { status: number; body: string };
  signed: Record<string, unknown>;
  cloud: Reply | 'network';
  complete: Reply;
  now: number;
  rng: number;
}

const DIR = '/tmp/timo-d7/uploader-parity';

async function runFlush(input: { rows: Array<Record<string, unknown>>; pending: string[] }): Promise<unknown> {
  resetSync();
  const marked: string[] = [];
  const store = {
    unsynced: (n: number) => input.rows.slice(0, n),
    markSynced: (ids: string[]) => void marked.push(...ids),
  };
  sync.apiHandler = async () => ({ accepted: 1, detached: 0 });
  try {
    const sent = await activitySync.flushActivity(store, (id) => input.pending.includes(id));
    return { sent, bodyText: sync.apiCalls[0]?.bodyText ?? null, marked };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), marked };
  }
}

function pending(): unknown {
  return sync.pending === null ? null : { verifier: sync.pending.verifier, loginUrl: sync.pending.loginUrl, createdAt: sync.pending.createdAt };
}

async function runAuth(input: AuthInput): Promise<unknown> {
  resetSync();
  setEnv(input.apiUrl, input.scheme);
  const queue = [...input.random];
  const realRandom = crypto.randomBytes;
  const realHostname = os.hostname;
  const realNow = Date.now;
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  (crypto as unknown as { randomBytes: unknown }).randomBytes = (n: number): Buffer => {
    const hex = queue.shift();
    if (hex === undefined || hex.length !== n * 2) throw new Error('rng exhausted');
    return Buffer.from(hex, 'hex');
  };
  const effects: unknown[] = [];
  try {
    auth.cancelLarkLogin();
    for (const op of input.ops) {
      Date.now = () => op.now;
      const sent = sync.apiCalls.length;
      const opened = sync.opened.length;
      const saved = sync.savedTokens.length;
      let result: unknown;
      try {
        if (op.op === 'start') {
          sync.openFails = op.openFails;
          await auth.startLarkLogin();
          result = 'ok';
        } else if (op.op === 'complete') {
          sync.apiHandler = async () => op.response;
          result = await auth.completeLarkLogin(op.code);
        } else if (op.op === 'cancel') {
          auth.cancelLarkLogin();
          result = 'ok';
        } else {
          os.hostname = () => op.hostname;
          Object.defineProperty(process, 'platform', { value: op.platform, configurable: true });
          sync.apiHandler = async () => op.response;
          result = await auth.login(op.email, op.password);
        }
      } catch (error) {
        result = { error: error instanceof Error ? error.message : String(error) };
      }
      effects.push({
        result,
        api: sync.apiCalls.slice(sent),
        opened: sync.opened.slice(opened),
        saved: sync.savedTokens.slice(saved),
        pending: pending(),
        workspaceClears: sync.workspaceClears,
      });
    }
  } finally {
    auth.cancelLarkLogin();
    (crypto as unknown as { randomBytes: unknown }).randomBytes = realRandom;
    os.hostname = realHostname;
    Date.now = realNow;
    if (realPlatform) Object.defineProperty(process, 'platform', realPlatform);
  }
  return { effects };
}


async function runFlow(input: FlowInput): Promise<unknown> {
  resetSync();
  mkdirSync(DIR, { recursive: true });
  const filePath = `${DIR}/${input.row.id}.webp`;
  if (input.fileExists) writeFileSync(filePath, Buffer.alloc(input.row.bytes, 0x57));
  const row = { ...input.row, filePath, uploadState: 'pending' };
  sync.apiHandler = async (path) => {
    if (path === '/v1/screenshots/sign') {
      if (input.sign === 'unauthorized') {
        // The real api() throws before sending anything when there are no tokens.
        sync.apiCalls.pop();
        throw new api.UnauthorizedError('no_tokens');
      }
      if (input.sign !== 'ok') throw new api.HttpError(path, input.sign.status, input.sign.body);
      return { cloudName: 'demo', ...input.signed };
    }
    if (input.complete.status >= 300) throw new api.HttpError(path, input.complete.status, input.complete.body);
    return JSON.parse(input.complete.body);
  };
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  const realRandom = Math.random;
  globalThis.fetch = (async (url: string, init: { method: string; body: FormData }) => {
    const fields: FetchCall['fields'] = [];
    for (const [name, value] of init.body.entries()) {
      fields.push([name, typeof value === 'string' ? value : { file: value.name, type: value.type, size: value.size }]);
    }
    sync.fetchCalls.push({ url, method: init.method, fields });
    if (input.cloud === 'network') throw new TypeError('fetch failed');
    const reply = input.cloud;
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, text: async () => reply.body, json: async () => JSON.parse(reply.body) };
  }) as unknown as typeof fetch;
  Date.now = () => input.now;
  Math.random = () => input.rng;
  try {
    await up.uploadScreenshotsNow([row]);
  } finally {
    globalThis.fetch = realFetch;
    Date.now = realNow;
    Math.random = realRandom;
    rmSync(filePath, { force: true });
  }
  return { api: sync.apiCalls, fetch: sync.fetchCalls, store: sync.storeCalls };
}


const RUNNERS: Record<string, (input: never) => Promise<unknown>> = {
  flush: runFlush as never,
  auth: runAuth as never,
  upload: runFlow as never,
};

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const { id, kind, input } = JSON.parse(line) as { id: number; kind: string; input: never };
  const runner = RUNNERS[kind];
  const output = runner ? await exclusive(() => runner(input)) : { error: `unknown scenario ${kind}` };
  process.stdout.write(`${JSON.stringify({ id, output })}\n`);
}
process.exit(0);
