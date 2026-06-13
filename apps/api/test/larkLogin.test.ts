import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { prisma } from '@grind/db';

// Set provisioning env BEFORE the service (and its env.ts) is first imported.
process.env.LARK_BOOTSTRAP_ADMIN_EMAILS = 'boss@co.com';
process.env.WORKSPACE_ID = 'ws_test';
const { resolveUser, createAgentAuthCode, redeemAgentAuthCode, AgentCodeError } = await import(
  '../src/auth/larkLogin'
);

type P = Parameters<typeof resolveUser>[0];
function profile(over: Partial<P> = {}): P {
  return { openId: 'ou_1', unionId: 'on_1', name: 'Alice', email: 'alice@co.com', avatarUrl: null, ...over };
}

function pkce() {
  const verifier = crypto.randomBytes(40).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

describe('resolveUser — provisioning', () => {
  it('creates an unknown user as PENDING MEMBER and provisions the workspace', async () => {
    const u = await resolveUser(profile());
    expect(u.role).toBe('MEMBER');
    expect(u.provisioningStatus).toBe('PENDING');
    expect(u.workspaceId).toBe('ws_test');
    const ws = await prisma.workspace.findUnique({ where: { id: 'ws_test' } });
    expect(ws).not.toBeNull();
    const ident = await prisma.larkIdentity.findUnique({ where: { openId: 'ou_1' } });
    expect(ident?.userId).toBe(u.id);
  });

  it('creates a bootstrap-admin email as ACTIVE ADMIN', async () => {
    const u = await resolveUser(profile({ openId: 'ou_boss', email: 'BOSS@co.com', name: 'Boss' }));
    expect(u.role).toBe('ADMIN');
    expect(u.provisioningStatus).toBe('ACTIVE');
  });

  it('returns the same user on a second login (by open_id) and syncs name/avatar', async () => {
    const first = await resolveUser(profile());
    const second = await resolveUser(profile({ name: 'Alice B', avatarUrl: 'http://x/a.png' }));
    expect(second.id).toBe(first.id);
    expect(second.name).toBe('Alice B');
    expect(second.avatarUrl).toBe('http://x/a.png');
    expect(await prisma.user.count()).toBe(1);
  });

  it('links the Lark identity to a pre-existing user matched by email', async () => {
    const existing = await prisma.user.create({
      data: { workspaceId: (await prisma.workspace.create({ data: { id: 'ws_test', name: 'W' } })).id, email: 'alice@co.com', name: 'Old', role: 'MANAGER', provisioningStatus: 'ACTIVE' },
    });
    const u = await resolveUser(profile());
    expect(u.id).toBe(existing.id);
    expect(u.role).toBe('MANAGER'); // hierarchy untouched
    const ident = await prisma.larkIdentity.findUnique({ where: { openId: 'ou_1' } });
    expect(ident?.userId).toBe(existing.id);
  });

  it('promotes a previously-PENDING user to ADMIN/ACTIVE when their email is a bootstrap email', async () => {
    const u1 = await resolveUser(profile({ openId: 'ou_boss', email: 'boss@co.com' }));
    // Simulate "created before the env was set": force back to pending member.
    await prisma.user.update({ where: { id: u1.id }, data: { role: 'MEMBER', provisioningStatus: 'PENDING' } });
    const u2 = await resolveUser(profile({ openId: 'ou_boss', email: 'boss@co.com' }));
    expect(u2.role).toBe('ADMIN');
    expect(u2.provisioningStatus).toBe('ACTIVE');
  });

  it('updates the stored email when Lark reports a new one (same open_id)', async () => {
    const u1 = await resolveUser(profile());
    const u2 = await resolveUser(profile({ email: 'alice.new@co.com' }));
    expect(u2.id).toBe(u1.id);
    expect(u2.email).toBe('alice.new@co.com');
  });

  it('is idempotent under concurrent first-logins (no duplicate users)', async () => {
    const results = await Promise.all([resolveUser(profile()), resolveUser(profile()), resolveUser(profile())]);
    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(1);
    expect(await prisma.user.count()).toBe(1);
  });
});

describe('agent one-time codes', () => {
  async function seedUserId(): Promise<string> {
    const u = await resolveUser(profile());
    return u.id;
  }

  it('round-trips a code → userId with the matching verifier', async () => {
    const userId = await seedUserId();
    const { verifier, challenge } = pkce();
    const code = await createAgentAuthCode(userId, challenge);
    expect(await redeemAgentAuthCode(code, verifier)).toBe(userId);
  });

  it('is single-use', async () => {
    const userId = await seedUserId();
    const { verifier, challenge } = pkce();
    const code = await createAgentAuthCode(userId, challenge);
    await redeemAgentAuthCode(code, verifier);
    await expect(redeemAgentAuthCode(code, verifier)).rejects.toMatchObject({ code: 'code_invalid' });
  });

  it('rejects a wrong PKCE verifier (interception defense)', async () => {
    const userId = await seedUserId();
    const { challenge } = pkce();
    const code = await createAgentAuthCode(userId, challenge);
    await expect(redeemAgentAuthCode(code, 'not-the-verifier')).rejects.toBeInstanceOf(AgentCodeError);
    await expect(redeemAgentAuthCode(code, 'not-the-verifier')).rejects.toMatchObject({ code: 'pkce_mismatch' });
  });

  it('rejects an expired code', async () => {
    const userId = await seedUserId();
    const { verifier, challenge } = pkce();
    const code = await createAgentAuthCode(userId, challenge);
    // Force expiry in the past.
    await prisma.agentAuthCode.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(redeemAgentAuthCode(code, verifier)).rejects.toMatchObject({ code: 'code_invalid' });
  });

  it('rejects an unknown code', async () => {
    await expect(redeemAgentAuthCode('nope', 'whatever')).rejects.toMatchObject({ code: 'code_invalid' });
  });
});
