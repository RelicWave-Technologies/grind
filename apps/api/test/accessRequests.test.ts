import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { NINE_TO_SIX } from '@grind/types';
import { setLarkMessengerForTests, type LarkMessenger, type SendCardResult } from '../src/lark';
import { signAccessToken } from '../src/lib/jwt';

// Provisioning reads WORKSPACE_ID when the login service is first imported.
process.env.WORKSPACE_ID = 'ws_access';
const { resolveUser } = await import('../src/auth/larkLogin');
const { buildApp } = await import('../src/app');
const { decideAccessRequestFromLark } = await import('../src/access/requests');
const { processAccessRequestLarkOutboxOnce, LARK_CARD_UPDATE_WINDOW_MS } = await import('../src/access/larkOutbox');

const app = buildApp();

class FakeMessenger implements LarkMessenger {
  sends: Array<{ openId: string; card: Record<string, unknown>; uuid?: string; messageId: string }> = [];
  updates: Array<{ messageId: string; card: Record<string, unknown> }> = [];
  async sendCard(openId: string, card: Record<string, unknown>, uuid?: string): Promise<SendCardResult> {
    const messageId = `om_access_${this.sends.length + 1}`;
    this.sends.push({ openId, card, uuid, messageId });
    return { messageId };
  }
  async sendCardToChat(): Promise<SendCardResult> { return { messageId: 'om_chat' }; }
  async updateCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    this.updates.push({ messageId, card });
  }
  async sendText(): Promise<SendCardResult> { return { messageId: 'om_txt' }; }
  async sendTextToChat(): Promise<SendCardResult> { return { messageId: 'om_txt_chat' }; }
}

let fake: FakeMessenger;
beforeEach(() => { fake = new FakeMessenger(); setLarkMessengerForTests(fake); });
afterAll(() => { setLarkMessengerForTests(null); });

async function drain() {
  for (let i = 0; i < 5; i += 1) await processAccessRequestLarkOutboxOnce(50);
}

async function mkAdmin(name: string, openId: string | null, extra: { deactivatedAt?: Date } = {}) {
  const user = await prisma.user.create({
    data: {
      workspaceId: 'ws_access',
      email: `${name.toLowerCase()}@co.com`,
      name,
      role: 'ADMIN',
      provisioningStatus: 'ACTIVE',
      ...extra,
    },
  });
  if (openId) await prisma.larkIdentity.create({ data: { userId: user.id, openId } });
  return { ...user, token: signAccessToken({ sub: user.id, ws: 'ws_access', role: 'ADMIN' }) };
}

async function seed() {
  await prisma.workspace.create({ data: { id: 'ws_access', name: 'W', timezone: 'Asia/Kolkata' } });
  const asha = await mkAdmin('Asha', 'ou_asha');
  const bilal = await mkAdmin('Bilal', 'ou_bilal');
  const noLark = await mkAdmin('Chen', null);
  await mkAdmin('Gone', 'ou_gone', { deactivatedAt: new Date() });
  const team = await prisma.team.create({ data: { workspaceId: 'ws_access', name: 'Sales' } });
  const quiet = await prisma.shift.create({ data: { workspaceId: 'ws_access', name: 'Late', schedule: NINE_TO_SIX } });
  const general = await prisma.shift.create({ data: { workspaceId: 'ws_access', name: 'General', schedule: NINE_TO_SIX } });
  await prisma.user.update({ where: { id: asha.id }, data: { shiftId: general.id } });
  return { asha, bilal, noLark, team, general, quiet };
}

async function newPerson() {
  const user = await resolveUser({ openId: 'ou_new', unionId: 'on_new', name: 'Neha New', email: 'neha@co.com', avatarUrl: null });
  const ar = await prisma.accessRequest.findUniqueOrThrow({ where: { userId: user.id } });
  return { user, ar };
}

describe('access requests on Lark', () => {
  it('a first login asks every admin with Lark once, and a retry login does not ask again', async () => {
    await seed();
    const { user, ar } = await newPerson();
    expect(user.provisioningStatus).toBe('PENDING');
    await resolveUser({ openId: 'ou_new', unionId: 'on_new', name: 'Neha New', email: 'neha@co.com', avatarUrl: null });
    expect(await prisma.accessRequest.count()).toBe(1);

    await drain();
    expect(fake.sends.map((s) => s.openId).sort()).toEqual(['ou_asha', 'ou_bilal']);
    const ledger = await prisma.accessRequestLarkMessage.findMany({ where: { accessRequestId: ar.id } });
    expect(ledger.every((l) => l.status === 'SENT')).toBe(true);
    expect(fake.sends.map((s) => s.uuid).sort()).toEqual(ledger.map((l) => l.id).sort());

    const json = JSON.stringify(fake.sends[0]!.card);
    expect(json).toContain('Neha New');
    expect(json).toContain('neha@co.com');
    expect(json).toContain('Sales');
    // The shift most people are on is pre-picked.
    const general = await prisma.shift.findFirstOrThrow({ where: { name: 'General' } });
    expect(json).toContain(`"initial_option":"${general.id}"`);

    // Running the event again sends nothing new.
    await prisma.accessRequestLarkOutboxEvent.updateMany({ data: { status: 'PENDING', nextRunAt: new Date(0) } });
    await drain();
    expect(fake.sends).toHaveLength(2);
  });

  it('sends only to the admins picked in Policy', async () => {
    const s = await seed();
    const get = await request(app).get('/v1/admin/access-requests/recipients').set('Authorization', `Bearer ${s.asha.token}`);
    expect(get.status).toBe(200);
    expect(get.body.allAdmins).toBe(true);
    expect(get.body.admins.map((a: { name: string }) => a.name)).toEqual(['Asha', 'Bilal', 'Chen']);

    const put = await request(app)
      .put('/v1/admin/access-requests/recipients')
      .set('Authorization', `Bearer ${s.asha.token}`)
      .send({ userIds: [s.bilal.id] });
    expect(put.status).toBe(200);
    expect(put.body.allAdmins).toBe(false);

    await newPerson();
    await drain();
    expect(fake.sends.map((x) => x.openId)).toEqual(['ou_bilal']);
  });

  it('refuses a non-admin as a recipient, and members cannot change it', async () => {
    const s = await seed();
    const { user } = await newPerson();
    const bad = await request(app)
      .put('/v1/admin/access-requests/recipients')
      .set('Authorization', `Bearer ${s.asha.token}`)
      .send({ userIds: [user.id] });
    expect(bad.status).toBe(400);
    const member = await prisma.user.create({
      data: { workspaceId: 'ws_access', email: 'm@co.com', name: 'M', role: 'MEMBER', provisioningStatus: 'ACTIVE' },
    });
    const denied = await request(app)
      .put('/v1/admin/access-requests/recipients')
      .set('Authorization', `Bearer ${signAccessToken({ sub: member.id, ws: 'ws_access', role: 'MEMBER' })}`)
      .send({ userIds: [] });
    expect(denied.status).toBe(403);
  });

  it('Approve activates with the team and shift picked, records who, and updates every card', async () => {
    const s = await seed();
    const { user, ar } = await newPerson();
    await drain();

    const out = await decideAccessRequestFromLark({
      accessRequestId: ar.id, action: 'approve', decidedByOpenId: 'ou_bilal', teamId: s.team.id, shiftId: s.quiet.id,
    });
    expect(out.ok && out.status).toBe('APPROVED');
    expect(out.ok && JSON.stringify(out.card)).toContain('Bilal');

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.provisioningStatus).toBe('ACTIVE');
    expect(after.teamId).toBe(s.team.id);
    expect(after.shiftId).toBe(s.quiet.id);
    const assignment = await prisma.shiftAssignment.findFirstOrThrow({ where: { userId: user.id, effectiveTo: null } });
    expect(assignment.shiftId).toBe(s.quiet.id);
    expect(assignment.shiftNameSnapshot).toBe('Late');

    const audit = await prisma.accessRequest.findUniqueOrThrow({ where: { id: ar.id } });
    expect(audit).toMatchObject({ status: 'APPROVED', decidedVia: 'LARK_CARD', decidedById: s.bilal.id, teamId: s.team.id, shiftId: s.quiet.id });

    await drain();
    expect(fake.updates.map((u) => u.messageId).sort()).toEqual(fake.sends.map((x) => x.messageId).sort());
    expect(JSON.stringify(fake.updates[0]!.card)).toContain('Access approved');
    const ledger = await prisma.accessRequestLarkMessage.findMany({ where: { accessRequestId: ar.id } });
    expect(ledger.every((l) => l.status === 'DECIDED')).toBe(true);
  });

  it('Approve without a team changes nothing', async () => {
    const s = await seed();
    const { user, ar } = await newPerson();
    const out = await decideAccessRequestFromLark({
      accessRequestId: ar.id, action: 'approve', decidedByOpenId: 'ou_asha', teamId: null, shiftId: s.general.id,
    });
    expect(out).toEqual({ ok: false, error: 'team_required' });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).provisioningStatus).toBe('PENDING');
    expect((await prisma.accessRequest.findUniqueOrThrow({ where: { id: ar.id } })).status).toBe('PENDING');
  });

  it('a double click or a second admin decides only once', async () => {
    const s = await seed();
    const { ar } = await newPerson();
    const args = { accessRequestId: ar.id, action: 'approve' as const, teamId: s.team.id, shiftId: s.general.id };
    const [a, b] = await Promise.all([
      decideAccessRequestFromLark({ ...args, decidedByOpenId: 'ou_asha' }),
      decideAccessRequestFromLark({ ...args, decidedByOpenId: 'ou_bilal' }),
    ]);
    expect([a, b].filter((r) => r.ok && !r.alreadyDecided)).toHaveLength(1);
    expect([a, b].filter((r) => r.ok && r.alreadyDecided)).toHaveLength(1);
    expect(await prisma.shiftAssignment.count({ where: { userId: ar.userId } })).toBe(1);
    expect(await prisma.accessRequestLarkOutboxEvent.count({ where: { accessRequestId: ar.id, kind: 'FINALIZE_CARDS' } })).toBe(1);

    const late = await decideAccessRequestFromLark({ ...args, action: 'reject', decidedByOpenId: 'ou_asha' });
    expect(late.ok && late.alreadyDecided && late.status).toBe('APPROVED');
  });

  it('Reject deactivates the person', async () => {
    await seed();
    const { user, ar } = await newPerson();
    const out = await decideAccessRequestFromLark({ accessRequestId: ar.id, action: 'reject', decidedByOpenId: 'ou_asha' });
    expect(out.ok && out.status).toBe('REJECTED');
    expect(JSON.stringify(out.ok && out.card)).toContain('Access rejected');
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.deactivatedAt).not.toBeNull();
    expect(after.provisioningStatus).toBe('PENDING');
  });

  it('only an active admin can decide', async () => {
    await seed();
    const { ar } = await newPerson();
    const member = await prisma.user.create({
      data: { workspaceId: 'ws_access', email: 'mem@co.com', name: 'Mem', role: 'MEMBER', provisioningStatus: 'ACTIVE' },
    });
    await prisma.larkIdentity.create({ data: { userId: member.id, openId: 'ou_mem' } });
    for (const openId of ['ou_mem', 'ou_gone', 'ou_stranger']) {
      const out = await decideAccessRequestFromLark({ accessRequestId: ar.id, action: 'reject', decidedByOpenId: openId });
      expect(out).toEqual({ ok: false, error: 'forbidden' });
    }
  });

  it('activating from the dashboard closes the cards, and a later click just shows the result', async () => {
    const s = await seed();
    const { user, ar } = await newPerson();
    await drain();

    const res = await request(app)
      .patch(`/v1/admin/users/${user.id}`)
      .set('Authorization', `Bearer ${s.asha.token}`)
      .send({ teamId: s.team.id, shiftId: s.general.id });
    expect(res.status).toBe(200);
    expect(res.body.provisioningStatus).toBe('ACTIVE');
    const audit = await prisma.accessRequest.findUniqueOrThrow({ where: { id: ar.id } });
    expect(audit).toMatchObject({ status: 'APPROVED', decidedVia: 'DASHBOARD', decidedById: s.asha.id });

    await drain();
    expect(fake.updates).toHaveLength(2);
    expect(JSON.stringify(fake.updates[0]!.card)).toContain('from the dashboard');

    const click = await decideAccessRequestFromLark({
      accessRequestId: ar.id, action: 'approve', decidedByOpenId: 'ou_bilal', teamId: s.team.id, shiftId: s.quiet.id,
    });
    expect(click.ok && click.alreadyDecided).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).shiftId).toBe(s.general.id);
  });

  it('deactivating a waiting person from the dashboard marks the cards rejected', async () => {
    const s = await seed();
    const { user, ar } = await newPerson();
    const res = await request(app).post(`/v1/admin/users/${user.id}/deactivate`).set('Authorization', `Bearer ${s.asha.token}`);
    expect(res.status).toBe(200);
    expect((await prisma.accessRequest.findUniqueOrThrow({ where: { id: ar.id } })).status).toBe('REJECTED');
  });

  it('leaves cards older than Lark’s 14-day window alone', async () => {
    const s = await seed();
    const { ar } = await newPerson();
    await drain();
    await prisma.accessRequestLarkMessage.updateMany({
      where: { recipientOpenId: 'ou_asha' },
      data: { sentAt: new Date(Date.now() - LARK_CARD_UPDATE_WINDOW_MS - 60_000) },
    });
    await decideAccessRequestFromLark({ accessRequestId: ar.id, action: 'reject', decidedByOpenId: 'ou_bilal' });
    await drain();
    expect(fake.updates).toHaveLength(1);
    const rows = await prisma.accessRequestLarkMessage.findMany({ where: { accessRequestId: ar.id }, orderBy: { recipientOpenId: 'asc' } });
    expect(rows.map((r) => [r.recipientOpenId, r.status])).toEqual([['ou_asha', 'EXPIRED'], ['ou_bilal', 'DECIDED']]);
    void s;
  });

  it('no cards go out when someone was let in before the worker ran', async () => {
    const s = await seed();
    const { user } = await newPerson();
    await request(app).post(`/v1/admin/users/${user.id}/activate`).set('Authorization', `Bearer ${s.asha.token}`);
    await drain();
    expect(fake.sends).toHaveLength(0);
  });
});
