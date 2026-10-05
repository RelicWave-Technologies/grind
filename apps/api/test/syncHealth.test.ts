import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';
import { runSyncHealthAlertOnce } from '../src/maintenance/syncHealthAlert';
import { MAX_STORED_PENDING } from '../src/agent/syncHealth';
import { createManagedTeam, midDayTimeZone } from './helpers';

const app = buildApp();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);

let counter = 0;
async function seed() {
  counter += 1;
  const stamp = `${Date.now()}-${counter}-sync`;
  const ws = await prisma.workspace.create({ data: { name: `WS ${stamp}`, timezone: midDayTimeZone() } });
  const mk = (name: string, role: 'ADMIN' | 'MANAGER' | 'MEMBER') =>
    prisma.user.create({
      data: { workspaceId: ws.id, email: `${name}-${stamp}@test.local`, name, role, passwordHash: 'x'.repeat(60) },
    });
  const admin = await mk('admin', 'ADMIN');
  const mgr = await mk('mgr', 'MANAGER');
  const teammate = await mk('teammate', 'MEMBER');
  const outsider = await mk('outsider', 'MEMBER');
  const team = await createManagedTeam({ workspaceId: ws.id, name: 'Squad', managerId: mgr.id });
  await prisma.user.updateMany({ where: { id: { in: [mgr.id, teammate.id] } }, data: { teamId: team.id } });
  const token = (u: { id: string; role: 'ADMIN' | 'MANAGER' | 'MEMBER' }) => signAccessToken({ sub: u.id, ws: ws.id, role: u.role });
  return {
    ws,
    admin: { id: admin.id, token: token(admin) },
    mgr: { id: mgr.id, token: token(mgr) },
    teammate: { id: teammate.id, token: token(teammate) },
    outsider: { id: outsider.id, token: token(outsider) },
  };
}

/** A person whose oldest upload has been waiting `pendingFor`, reported a minute ago. */
async function makeStuck(userId: string, pendingFor = 3 * 60 * MIN) {
  await prisma.user.update({
    where: { id: userId },
    data: {
      agentVersion: '0.0.2-beta.39',
      agentPlatform: 'darwin',
      agentLastSeenAt: ago(MIN),
      agentOsVersion: '15.1',
      agentArch: 'arm64',
      agentSyncPending: 4,
      agentSyncOldestPendingAt: ago(pendingFor),
      agentSyncPendingSince: ago(pendingFor),
      agentSyncLastError: 'http_409:timer_conflict',
      agentSyncErrorSince: ago(pendingFor),
      agentDiagnosticsUpdatedAt: ago(MIN),
    },
  });
}

function heartbeat(token: string, diagnostics?: Record<string, unknown>) {
  return request(app).post('/v1/agent/heartbeat').set(bearer(token)).send({
    agentVersion: '0.0.2-beta.39',
    platform: 'darwin',
    state: 'IDLE',
    ...(diagnostics ? { diagnostics } : {}),
  });
}

const diag = (syncPending: number, syncLastError: string | null = null, syncOldestPendingAt: string | null = null) => ({
  osVersion: '15.1',
  arch: 'arm64',
  syncPending,
  syncOldestPendingAt,
  syncLastError,
});

type UserRow = { id: string; sync: null | { status: string; reason: string; pending: number | null; lastErrorLabel: string | null } };

describe('heartbeat sync bookkeeping', () => {
  it('starts the pending clock on the server, keeps it across reports, and clears it (and the alert) when empty', async () => {
    const s = await seed();
    expect((await heartbeat(s.teammate.token, diag(2, 'http_409:timer_conflict', ago(5 * 60 * MIN).toISOString()))).status).toBe(200);
    const first = await prisma.user.findUniqueOrThrow({ where: { id: s.teammate.id } });
    expect(first.agentSyncPendingSince).toBeInstanceOf(Date);
    expect(first.agentSyncErrorSince).toBeInstanceOf(Date);

    expect((await heartbeat(s.teammate.token, diag(3, 'http_409:timer_conflict'))).status).toBe(200);
    const second = await prisma.user.findUniqueOrThrow({ where: { id: s.teammate.id } });
    expect(second.agentSyncPendingSince).toEqual(first.agentSyncPendingSince);
    expect(second.agentSyncErrorSince).toEqual(first.agentSyncErrorSince);

    await prisma.user.update({ where: { id: s.teammate.id }, data: { agentSyncAlertedAt: new Date() } });
    expect((await heartbeat(s.teammate.token, diag(0))).status).toBe(200);
    const cleared = await prisma.user.findUniqueOrThrow({ where: { id: s.teammate.id } });
    expect(cleared).toMatchObject({ agentSyncPending: 0, agentSyncPendingSince: null, agentSyncErrorSince: null, agentSyncAlertedAt: null });
  });

  it('accepts a pending count larger than the column and stores the ceiling', async () => {
    const s = await seed();
    const res = await heartbeat(s.teammate.token, diag(1e15));
    expect(res.status).toBe(200);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: s.teammate.id } });
    expect(row.agentSyncPending).toBe(MAX_STORED_PENDING);
  });

  it('leaves the sync columns alone for an agent that sends no diagnostics', async () => {
    const s = await seed();
    await makeStuck(s.teammate.id);
    expect((await heartbeat(s.teammate.token)).status).toBe(200);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: s.teammate.id } });
    expect(row.agentSyncPending).toBe(4);
  });
});

describe('GET /v1/admin/users sync health', () => {
  it('shows each person’s verdict to an admin, with the detail', async () => {
    const s = await seed();
    await makeStuck(s.teammate.id);
    await prisma.user.update({ where: { id: s.outsider.id }, data: { agentVersion: '0.0.2-beta.20', agentLastSeenAt: ago(MIN) } });

    const res = await request(app).get('/v1/admin/users').set(bearer(s.admin.token));
    expect(res.status).toBe(200);
    const byId = new Map((res.body.users as UserRow[]).map((u) => [u.id, u]));
    expect(byId.get(s.teammate.id)!.sync).toMatchObject({
      status: 'STUCK',
      pending: 4,
      lastErrorLabel: 'Another device holds the running timer',
      agentVersion: '0.0.2-beta.39',
      osVersion: '15.1',
      arch: 'arm64',
    });
    expect(byId.get(s.outsider.id)!.sync).toMatchObject({ status: 'UNKNOWN', reason: 'no_diagnostics' });
    expect(byId.get(s.admin.id)!.sync).toMatchObject({ status: 'UNKNOWN', reason: 'no_agent' });
  });

  it('shows a manager only their team, and a member nothing', async () => {
    const s = await seed();
    await makeStuck(s.teammate.id);
    await makeStuck(s.outsider.id);

    const asManager = await request(app).get('/v1/admin/users').set(bearer(s.mgr.token));
    expect(asManager.status).toBe(200);
    const ids = (asManager.body.users as UserRow[]).map((u) => u.id);
    expect(ids).toContain(s.teammate.id);
    expect(ids).not.toContain(s.outsider.id);
    expect((asManager.body.users as UserRow[]).find((u) => u.id === s.teammate.id)!.sync?.status).toBe('STUCK');

    const asMember = await request(app).get('/v1/admin/users').set(bearer(s.outsider.token));
    expect(asMember.status).toBe(200);
    expect((asMember.body.users as UserRow[]).every((u) => u.sync === null)).toBe(true);
  });

  it('gives deactivated people no verdict', async () => {
    const s = await seed();
    await makeStuck(s.outsider.id);
    await prisma.user.update({ where: { id: s.outsider.id }, data: { deactivatedAt: new Date() } });
    const res = await request(app).get('/v1/admin/users?includeDeactivated=true').set(bearer(s.admin.token));
    const row = (res.body.users as UserRow[]).find((u) => u.id === s.outsider.id)!;
    expect(row.sync).toBeNull();
  });
});

describe('GET /v1/admin/overview agentSync', () => {
  it('counts stuck and behind people in the caller’s scope only', async () => {
    const s = await seed();
    await makeStuck(s.teammate.id);
    await makeStuck(s.outsider.id, 20 * MIN); // BEHIND, outside the manager's team

    const asAdmin = await request(app).get('/v1/admin/overview').set(bearer(s.admin.token));
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.agentSync).toEqual({ stuck: 1, behind: 1 });

    const asManager = await request(app).get('/v1/admin/overview').set(bearer(s.mgr.token));
    expect(asManager.body.agentSync).toEqual({ stuck: 1, behind: 0 });
  });

  it('does not count a deactivated person', async () => {
    const s = await seed();
    await makeStuck(s.teammate.id);
    await prisma.user.update({ where: { id: s.teammate.id }, data: { deactivatedAt: new Date() } });
    const res = await request(app).get('/v1/admin/overview').set(bearer(s.admin.token));
    expect(res.body.agentSync).toEqual({ stuck: 0, behind: 0 });
  });
});

describe('stuck-sync alert', () => {
  it('alerts once per episode and again only after recovery', async () => {
    const s = await seed();
    await makeStuck(s.teammate.id);

    const first = await runSyncHealthAlertOnce();
    expect(first.alerted).toContain(s.teammate.id);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: s.teammate.id } })).agentSyncAlertedAt).toBeInstanceOf(Date);

    const again = await runSyncHealthAlertOnce();
    expect(again.alerted).not.toContain(s.teammate.id);

    // Recovered: the next heartbeat reports an empty queue.
    expect((await heartbeat(s.teammate.token, diag(0))).status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: s.teammate.id } })).agentSyncAlertedAt).toBeNull();

    await makeStuck(s.teammate.id);
    expect((await runSyncHealthAlertOnce()).alerted).toContain(s.teammate.id);
  });

  it('re-arms when a pass sees the person healthy again, but not while they are offline', async () => {
    const s = await seed();
    await makeStuck(s.teammate.id);
    await runSyncHealthAlertOnce();

    // Offline: the last report is 20 minutes old — UNKNOWN, so nothing changes.
    await prisma.user.update({ where: { id: s.teammate.id }, data: { agentDiagnosticsUpdatedAt: ago(20 * MIN) } });
    await runSyncHealthAlertOnce();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: s.teammate.id } })).agentSyncAlertedAt).toBeInstanceOf(Date);

    // Back, and only a minute behind now.
    await prisma.user.update({
      where: { id: s.teammate.id },
      data: { agentDiagnosticsUpdatedAt: ago(MIN), agentSyncPendingSince: ago(MIN), agentSyncLastError: null, agentSyncErrorSince: null },
    });
    const pass = await runSyncHealthAlertOnce();
    expect(pass.cleared).toBeGreaterThanOrEqual(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: s.teammate.id } })).agentSyncAlertedAt).toBeNull();
  });

  it('never alerts for a deactivated person, or from a stale report', async () => {
    const s = await seed();
    await makeStuck(s.teammate.id);
    await prisma.user.update({ where: { id: s.teammate.id }, data: { deactivatedAt: new Date() } });
    await makeStuck(s.outsider.id);
    await prisma.user.update({ where: { id: s.outsider.id }, data: { agentDiagnosticsUpdatedAt: ago(20 * MIN) } });

    const pass = await runSyncHealthAlertOnce();
    expect(pass.alerted).not.toContain(s.teammate.id);
    expect(pass.alerted).not.toContain(s.outsider.id);
  });
});
