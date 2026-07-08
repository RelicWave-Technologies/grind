import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { seedUser } from './helpers';

const app = buildApp();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function createToken(accessToken: string, scopes: string[] = ['read:people']) {
  const res = await request(app)
    .post('/v1/admin/api-tokens')
    .set(bearer(accessToken))
    .send({ name: 'Local MCP', scopes });
  expect(res.status).toBe(201);
  return res.body as { token: string; apiToken: { id: string; tokenPrefix: string } };
}

describe('admin API tokens', () => {
  it('lets admins create and list tokens, but returns the raw secret only once', async () => {
    const admin = await seedUser({ role: 'ADMIN' });

    const created = await createToken(admin.accessToken, ['read:people', 'read:device-health']);
    expect(created.token).toMatch(/^timo_mcp_atk_[A-Za-z0-9_-]{12}\.[A-Za-z0-9_-]{32,}$/);
    expect(created.apiToken.tokenPrefix).toMatch(/^timo_mcp_atk_[A-Za-z0-9_-]{12}$/);

    const row = await prisma.apiToken.findUniqueOrThrow({ where: { id: created.apiToken.id } });
    expect(row.tokenHash).not.toContain(created.token);

    const list = await request(app)
      .get('/v1/admin/api-tokens')
      .set(bearer(admin.accessToken));
    expect(list.status).toBe(200);
    expect(list.body.tokens).toHaveLength(1);
    expect(list.body.tokens[0].token).toBeUndefined();
    expect(list.body.tokens[0].tokenPrefix).toBe(created.apiToken.tokenPrefix);
  });

  it('blocks managers and members from creating tokens', async () => {
    const manager = await seedUser({ role: 'MANAGER' });
    const member = await seedUser({ role: 'MEMBER' });

    for (const user of [manager, member]) {
      const res = await request(app)
        .post('/v1/admin/api-tokens')
        .set(bearer(user.accessToken))
        .send({ name: 'Nope', scopes: ['read:people'] });
      expect(res.status).toBe(403);
    }
  });

  it('updates last-used and serves scoped MCP routes with a valid token', async () => {
    const admin = await seedUser({ role: 'ADMIN' });
    await prisma.user.update({
      where: { id: admin.userId },
      data: { agentVersion: '0.0.2-beta.25', agentPlatform: 'darwin', agentState: 'RUNNING' },
    });
    const created = await createToken(admin.accessToken, ['read:device-health']);

    const res = await request(app)
      .get('/v1/mcp/version-adoption')
      .set(bearer(created.token));

    expect(res.status).toBe(200);
    expect(res.body.totalUsers).toBe(1);
    expect(res.body.buckets).toEqual([
      { platform: 'darwin', version: '0.0.2-beta.25', state: 'RUNNING', count: 1 },
    ]);

    const row = await prisma.apiToken.findUniqueOrThrow({ where: { id: created.apiToken.id } });
    expect(row.lastUsedAt).toBeInstanceOf(Date);
  });

  it('rejects revoked tokens and tokens missing a required scope', async () => {
    const admin = await seedUser({ role: 'ADMIN' });
    const peopleOnly = await createToken(admin.accessToken, ['read:people']);

    const wrongScope = await request(app)
      .get('/v1/mcp/device-health')
      .set(bearer(peopleOnly.token));
    expect(wrongScope.status).toBe(403);

    await request(app)
      .post(`/v1/admin/api-tokens/${peopleOnly.apiToken.id}/revoke`)
      .set(bearer(admin.accessToken))
      .expect(200);

    const revoked = await request(app)
      .get('/v1/mcp/people')
      .set(bearer(peopleOnly.token));
    expect(revoked.status).toBe(401);
  });

  it('keeps MCP responses scoped to the token owner workspace', async () => {
    const first = await seedUser({ role: 'ADMIN' });
    const second = await seedUser({ role: 'ADMIN' });
    await prisma.user.update({ where: { id: first.userId }, data: { name: 'First Admin' } });
    await prisma.user.update({ where: { id: second.userId }, data: { name: 'Second Admin' } });
    const created = await createToken(first.accessToken, ['read:people']);

    const res = await request(app)
      .get('/v1/mcp/people')
      .set(bearer(created.token));

    expect(res.status).toBe(200);
    expect(res.body.users.map((user: { name: string }) => user.name)).toEqual(['First Admin']);
  });
});
