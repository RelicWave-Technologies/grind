import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { issueRefreshToken } from '../src/lib/refreshToken';
import { seedUser } from './helpers';

/**
 * Suspending someone has to actually take their access away.
 *
 * The flag by itself only ever stopped NEW logins. An agent already holding a
 * refresh token rotated it indefinitely, so what really stopped a suspended
 * person was the shipped agent noticing its heartbeat had gone unauthorized and
 * choosing to stop. That is the client being well behaved, not the server
 * revoking anything — a stale token, or a client that ignored the heartbeat,
 * kept working.
 */

const app = buildApp();

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function seedAdminAndMember() {
  const admin = await seedUser({ role: 'ADMIN' });
  const member = await prisma.user.create({
    data: {
      workspaceId: admin.workspaceId,
      email: `member-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`,
      name: 'Member',
      role: 'MEMBER',
      provisioningStatus: 'ACTIVE',
      passwordHash: 'x'.repeat(60),
    },
  });
  return { admin, memberId: member.id };
}

describe('suspending a member', () => {
  it('refuses to rotate a refresh token they already hold', async () => {
    const { memberId } = await seedAdminAndMember();
    const { refreshToken } = await issueRefreshToken(memberId, 'their laptop');

    // Rotating works right up until the moment they are suspended.
    const before = await request(app).post('/v1/auth/refresh').send({ refreshToken });
    expect(before.status).toBe(200);
    const rotated = before.body.refreshToken as string;

    await prisma.user.update({ where: { id: memberId }, data: { deactivatedAt: new Date() } });

    const after = await request(app).post('/v1/auth/refresh').send({ refreshToken: rotated });

    expect(after.status).toBe(401);
    expect(after.body).toMatchObject({ error: 'invalid_refresh', reason: 'deactivated' });
  });

  it('kills the session they are holding at the moment of suspension', async () => {
    const { admin, memberId } = await seedAdminAndMember();
    const { refreshToken } = await issueRefreshToken(memberId, 'their laptop');

    const res = await request(app)
      .post(`/v1/admin/users/${memberId}/deactivate`)
      .set(auth(admin.accessToken));

    expect(res.status).toBe(200);
    expect(res.body.sessionsRevoked).toBe(1);

    const refresh = await request(app).post('/v1/auth/refresh').send({ refreshToken });
    expect(refresh.status).toBe(401);
  });

  it('leaves everybody else signed in', async () => {
    const { admin, memberId } = await seedAdminAndMember();
    const other = await prisma.user.create({
      data: {
        workspaceId: admin.workspaceId,
        email: `other-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`,
        name: 'Other',
        role: 'MEMBER',
        provisioningStatus: 'ACTIVE',
        passwordHash: 'x'.repeat(60),
      },
    });
    const theirs = await issueRefreshToken(other.id, 'another laptop');

    await request(app)
      .post(`/v1/admin/users/${memberId}/deactivate`)
      .set(auth(admin.accessToken));

    const refresh = await request(app)
      .post('/v1/auth/refresh')
      .send({ refreshToken: theirs.refreshToken });

    expect(refresh.status).toBe(200);
  });

  it('lets them back in once reactivated', async () => {
    const { admin, memberId } = await seedAdminAndMember();

    await request(app)
      .post(`/v1/admin/users/${memberId}/deactivate`)
      .set(auth(admin.accessToken));
    await request(app)
      .post(`/v1/admin/users/${memberId}/reactivate`)
      .set(auth(admin.accessToken));

    // The old tokens stay dead — revocation is not undone — but a fresh one works.
    const { refreshToken } = await issueRefreshToken(memberId, 'their laptop');
    const refresh = await request(app).post('/v1/auth/refresh').send({ refreshToken });

    expect(refresh.status).toBe(200);
  });
});
