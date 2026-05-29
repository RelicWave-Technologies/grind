import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@grind/db';
import { resolveIdentity, type TenantClient, type ResolvedLarkUser } from '../src/lark/identity';
import { seedUser } from './helpers';

class FakeTenant implements TenantClient {
  calls: string[] = [];
  constructor(private readonly map: Record<string, ResolvedLarkUser>) {}
  async resolveByEmail(email: string): Promise<ResolvedLarkUser | null> {
    this.calls.push(email);
    return this.map[email] ?? null;
  }
}

let userId: string;
let email: string;
beforeEach(async () => {
  const u = await seedUser();
  userId = u.userId;
  const row = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  email = row.email;
});

describe('resolveIdentity', () => {
  it('upserts a LarkIdentity when the email resolves', async () => {
    const client = new FakeTenant({ [email]: { openId: 'ou_abc', unionId: 'on_xyz' } });
    const resolved = await resolveIdentity(prisma, userId, email, client);
    expect(resolved).toMatchObject({ openId: 'ou_abc' });
    const row = await prisma.larkIdentity.findUnique({ where: { userId } });
    expect(row).toMatchObject({ openId: 'ou_abc', unionId: 'on_xyz' });
  });

  it('returns null and writes nothing when the email is not in the tenant', async () => {
    const client = new FakeTenant({});
    const resolved = await resolveIdentity(prisma, userId, email, client);
    expect(resolved).toBeNull();
    expect(await prisma.larkIdentity.findUnique({ where: { userId } })).toBeNull();
  });

  it('is idempotent and updates open_id on re-resolution', async () => {
    await resolveIdentity(prisma, userId, email, new FakeTenant({ [email]: { openId: 'ou_old' } }));
    await resolveIdentity(prisma, userId, email, new FakeTenant({ [email]: { openId: 'ou_new' } }));
    const rows = await prisma.larkIdentity.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.openId).toBe('ou_new');
  });
});
