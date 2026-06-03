import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';
import { setLarkMessengerForTests, type LarkMessenger } from '../src/lark';
import { ulid } from 'ulid';

const app = buildApp();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

let counter = 0;
async function seed() {
  counter += 1;
  const stamp = `${Date.now()}-${counter}-dig`;
  const ws = await prisma.workspace.create({ data: { name: `WS ${stamp}` } });
  const mk = (email: string, role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER') =>
    prisma.user.create({
      data: {
        workspaceId: ws.id,
        email: `${email}-${stamp}@test.local`,
        name: email,
        role,
        passwordHash: 'x'.repeat(60),
      },
    });
  const admin = await mk('admin', 'ADMIN');
  const mgr1 = await mk('mgr1', 'MANAGER');
  const mgr2 = await mk('mgr2', 'MANAGER');
  const member = await mk('mem', 'MEMBER');
  const token = (u: { id: string; role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER' }) =>
    signAccessToken({ sub: u.id, ws: ws.id, role: u.role });
  return {
    ws,
    admin: { id: admin.id, token: token(admin) },
    mgr1: { id: mgr1.id, token: token(mgr1) },
    mgr2: { id: mgr2.id, token: token(mgr2) },
    member: { id: member.id, token: token(member) },
  };
}

async function makeRequest(opts: {
  userId: string;
  approverId: string | null;
  ageMs: number;
}) {
  const now = Date.now();
  const start = now - opts.ageMs - 2 * 60 * 60 * 1000;
  return prisma.manualTimeRequest.create({
    data: {
      clientUuid: ulid(),
      userId: opts.userId,
      approverId: opts.approverId,
      status: 'PENDING',
      requestedStart: new Date(start),
      requestedEnd: new Date(start + 60 * 60 * 1000),
      reason: 'forgot to start tracker',
      createdAt: new Date(now - opts.ageMs),
    },
  });
}

class FakeMessenger implements LarkMessenger {
  texts: Array<{ openId: string; text: string }> = [];
  async sendCard() {
    return { messageId: 'm_card' };
  }
  async sendText(openId: string, text: string) {
    this.texts.push({ openId, text });
    return { messageId: `m_${this.texts.length}` };
  }
  async updateCard() {
    /* no-op */
  }
}

class FailingMessenger extends FakeMessenger {
  override async sendText() {
    throw new Error('boom');
  }
}

beforeEach(() => {
  setLarkMessengerForTests(null);
});

describe('GET /v1/admin/digests/pending', () => {
  it('returns empty when nothing is pending', async () => {
    const { mgr1 } = await seed();
    const res = await request(app).get('/v1/admin/digests/pending').set(bearer(mgr1.token));
    expect(res.status).toBe(200);
    expect(res.body.digests).toEqual([]);
  });

  it('groups per approver, marks stuck items, sorts approvers correctly', async () => {
    const HOUR = 60 * 60 * 1000;
    const { mgr1, mgr2, member } = await seed();
    // mgr1: 1 stuck + 1 fresh
    await makeRequest({ userId: member.id, approverId: mgr1.id, ageMs: 60 * HOUR });
    await makeRequest({ userId: member.id, approverId: mgr1.id, ageMs: 1 * HOUR });
    // mgr2: 2 stuck
    await makeRequest({ userId: member.id, approverId: mgr2.id, ageMs: 70 * HOUR });
    await makeRequest({ userId: member.id, approverId: mgr2.id, ageMs: 50 * HOUR });

    const res = await request(app).get('/v1/admin/digests/pending').set(bearer(mgr1.token));
    expect(res.status).toBe(200);
    expect(res.body.digests).toHaveLength(2);
    // mgr2 first (most stuck).
    expect(res.body.digests[0].approverId).toBe(mgr2.id);
    expect(res.body.digests[0].stuckCount).toBe(2);
    expect(res.body.digests[1].approverId).toBe(mgr1.id);
    expect(res.body.digests[1].stuckCount).toBe(1);
    expect(res.body.digests[1].freshCount).toBe(1);
  });

  it('collapses null approver into __unassigned__', async () => {
    const HOUR = 60 * 60 * 1000;
    const { mgr1, member } = await seed();
    await makeRequest({ userId: member.id, approverId: null, ageMs: 60 * HOUR });

    const res = await request(app).get('/v1/admin/digests/pending').set(bearer(mgr1.token));
    expect(res.status).toBe(200);
    const unassigned = res.body.digests.find((d: { approverId: string }) => d.approverId === '__unassigned__');
    expect(unassigned).toBeDefined();
    expect(unassigned.approverName).toBeNull();
  });

  it('rejects MEMBER (manager-or-above only)', async () => {
    const { member } = await seed();
    const res = await request(app).get('/v1/admin/digests/pending').set(bearer(member.token));
    expect(res.status).toBe(403);
  });

  it('only includes the caller\'s workspace requests', async () => {
    const HOUR = 60 * 60 * 1000;
    const a = await seed();
    const b = await seed();
    // Pending in workspace B.
    await makeRequest({ userId: b.member.id, approverId: b.mgr1.id, ageMs: 60 * HOUR });
    const res = await request(app).get('/v1/admin/digests/pending').set(bearer(a.admin.token));
    expect(res.status).toBe(200);
    expect(res.body.digests).toEqual([]);
  });
});

describe('POST /v1/admin/digests/pending/send', () => {
  it('rejects MANAGER (admin-only)', async () => {
    const { mgr1 } = await seed();
    const res = await request(app)
      .post('/v1/admin/digests/pending/send')
      .set(bearer(mgr1.token));
    expect(res.status).toBe(403);
  });

  it('returns 503 when Lark is not configured', async () => {
    const { admin } = await seed();
    setLarkMessengerForTests(null);
    // The real configured-check uses env, which is unset in the test env.
    const res = await request(app)
      .post('/v1/admin/digests/pending/send')
      .set(bearer(admin.token));
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('lark_not_configured');
  });

  it('skips approvers without a LarkIdentity (skippedNoLark)', async () => {
    const HOUR = 60 * 60 * 1000;
    const { admin, mgr1, member } = await seed();
    await makeRequest({ userId: member.id, approverId: mgr1.id, ageMs: 60 * HOUR });
    const fake = new FakeMessenger();
    setLarkMessengerForTests(fake);
    const res = await request(app)
      .post('/v1/admin/digests/pending/send')
      .set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(0);
    expect(res.body.skippedNoLark).toBe(1);
    expect(fake.texts).toHaveLength(0);
  });

  it('sends a text via the messenger when LarkIdentity exists', async () => {
    const HOUR = 60 * 60 * 1000;
    const { admin, mgr1, member } = await seed();
    await prisma.larkIdentity.create({
      data: { userId: mgr1.id, openId: `ou_${mgr1.id.slice(0, 8)}` },
    });
    await makeRequest({ userId: member.id, approverId: mgr1.id, ageMs: 60 * HOUR });
    const fake = new FakeMessenger();
    setLarkMessengerForTests(fake);
    const res = await request(app)
      .post('/v1/admin/digests/pending/send')
      .set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(1);
    expect(res.body.skippedNoLark).toBe(0);
    expect(fake.texts).toHaveLength(1);
    expect(fake.texts[0]?.openId).toBe(`ou_${mgr1.id.slice(0, 8)}`);
    expect(fake.texts[0]?.text).toContain('stuck approval');
  });

  it('counts __unassigned__ items as skippedUnassigned (never sends)', async () => {
    const HOUR = 60 * 60 * 1000;
    const { admin, member } = await seed();
    await makeRequest({ userId: member.id, approverId: null, ageMs: 60 * HOUR });
    await makeRequest({ userId: member.id, approverId: null, ageMs: 50 * HOUR });
    const fake = new FakeMessenger();
    setLarkMessengerForTests(fake);
    const res = await request(app)
      .post('/v1/admin/digests/pending/send')
      .set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(0);
    expect(res.body.skippedUnassigned).toBe(2);
    expect(fake.texts).toHaveLength(0);
  });

  it('reports send failures without aborting the batch', async () => {
    const HOUR = 60 * 60 * 1000;
    const { admin, mgr1, mgr2, member } = await seed();
    await prisma.larkIdentity.create({ data: { userId: mgr1.id, openId: `ou_a_${mgr1.id.slice(0, 6)}` } });
    await prisma.larkIdentity.create({ data: { userId: mgr2.id, openId: `ou_b_${mgr2.id.slice(0, 6)}` } });
    await makeRequest({ userId: member.id, approverId: mgr1.id, ageMs: 60 * HOUR });
    await makeRequest({ userId: member.id, approverId: mgr2.id, ageMs: 60 * HOUR });
    const fail = new FailingMessenger();
    setLarkMessengerForTests(fail);
    const res = await request(app)
      .post('/v1/admin/digests/pending/send')
      .set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(0);
    expect(res.body.failed).toBe(2);
    expect(res.body.errors).toHaveLength(2);
  });
});
