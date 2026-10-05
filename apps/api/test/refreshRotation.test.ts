import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { hashPassword } from '../src/lib/password';
import { REFRESH_REUSE_GRACE_MS, sha256 } from '../src/lib/refreshToken';

/**
 * Production-grade refresh-token rotation:
 *   - /v1/auth/refresh (agent, bearer body) rotates single-use.
 *   - /v1/auth/refresh-cookie (dashboard, httpOnly cookie) rotates + re-sets cookies.
 *   - Reuse of an already-spent token outside a short browser-concurrency
 *     grace trips reuse-detection and revokes the whole family.
 */

const app = buildApp();

let counter = 0;
async function login() {
  counter += 1;
  const ws = await prisma.workspace.create({ data: { name: `WS-rot-${counter}-${Date.now()}` } });
  const password = `sekret-rot-${counter}`;
  const user = await prisma.user.create({
    data: {
      workspaceId: ws.id,
      email: `rot-${Date.now()}-${counter}@test.local`,
      name: `Rot User ${counter}`,
      role: 'MEMBER',
      passwordHash: await hashPassword(password),
    },
  });
  const res = await request(app).post('/v1/auth/login').send({ email: user.email, password });
  return { user, res };
}

function grindRt(setCookie: string[] | string | undefined): string | null {
  const arr = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const hit = arr.find((c) => c.startsWith('grind_rt='));
  if (!hit) return null;
  const val = hit.split(';')[0].slice('grind_rt='.length);
  return val || null;
}

describe('refresh rotation', () => {
  it('login sets both grind_at and grind_rt cookies', async () => {
    const { res } = await login();
    const cookies = res.headers['set-cookie'] as unknown as string[];
    const joined = cookies.join('; ');
    expect(joined).toMatch(/grind_at=/);
    expect(joined).toMatch(/grind_rt=/);
    expect(joined.toLowerCase()).toContain('httponly');
  });

  it('POST /v1/auth/refresh rotates; an immediate duplicate (lost response) rotates again', async () => {
    const { res } = await login();
    const rt = res.body.refreshToken as string;
    const first = await request(app).post('/v1/auth/refresh').send({ refreshToken: rt });
    expect(first.status).toBe(200);
    expect(first.body.accessToken).toBeTruthy();
    expect(first.body.refreshToken).toBeTruthy();
    expect(first.body.refreshToken).not.toBe(rt);
    // The first response never reached the client, which retries with the token
    // it still holds. Its successor was never used, so this is a lost response,
    // not a theft: rotate again rather than revoking the family.
    const duplicate = await request(app).post('/v1/auth/refresh').send({ refreshToken: rt });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.refreshToken).toBeTruthy();
    expect(duplicate.body.refreshToken).not.toBe(first.body.refreshToken);

    const stillLive = await request(app).post('/v1/auth/refresh').send({ refreshToken: duplicate.body.refreshToken });
    expect(stillLive.status).toBe(200);
  });

  it('a lost-response retry leaves exactly one live token in the family', async () => {
    const { user, res } = await login();
    const rt = res.body.refreshToken as string;
    const first = await request(app).post('/v1/auth/refresh').send({ refreshToken: rt });
    expect(first.status).toBe(200);

    const retry = await request(app).post('/v1/auth/refresh').send({ refreshToken: rt });
    expect(retry.status).toBe(200);

    // The never-delivered successor is retired; only the retry's token lives.
    const live = await prisma.refreshToken.findMany({
      where: { userId: user.id, revokedAt: null },
      select: { tokenHash: true },
    });
    expect(live).toHaveLength(1);
    expect(live[0].tokenHash).toBe(sha256(retry.body.refreshToken as string));
  });

  it('a retry after the successor was already used is benign: 409, family intact', async () => {
    const { res } = await login();
    const rt0 = res.body.refreshToken as string;
    const r1 = await request(app).post('/v1/auth/refresh').send({ refreshToken: rt0 });
    const r2 = await request(app).post('/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken });
    expect(r2.status).toBe(200);

    const replay = await request(app).post('/v1/auth/refresh').send({ refreshToken: rt0 });
    expect(replay.status).toBe(409);
    expect(replay.body.reason).toBe('reuse_grace');

    const current = await request(app).post('/v1/auth/refresh').send({ refreshToken: r2.body.refreshToken });
    expect(current.status).toBe(200);
  });

  it('two parallel refreshes of one token never leave two live successors', async () => {
    const { user, res } = await login();
    const rt = res.body.refreshToken as string;
    const results = await Promise.all([
      request(app).post('/v1/auth/refresh').send({ refreshToken: rt }),
      request(app).post('/v1/auth/refresh').send({ refreshToken: rt }),
      request(app).post('/v1/auth/refresh').send({ refreshToken: rt }),
    ]);
    for (const r of results) expect([200, 409]).toContain(r.status);
    expect(results.some((r) => r.status === 200)).toBe(true);

    const live = await prisma.refreshToken.findMany({ where: { userId: user.id, revokedAt: null } });
    expect(live).toHaveLength(1);
  });

  it('a replay outside the grace window with an unused successor is still reuse', async () => {
    const { res } = await login();
    const rt0 = res.body.refreshToken as string;
    const r1 = await request(app).post('/v1/auth/refresh').send({ refreshToken: rt0 });
    await prisma.refreshToken.update({
      where: { tokenHash: sha256(rt0) },
      data: { revokedAt: new Date(Date.now() - REFRESH_REUSE_GRACE_MS - 1000) },
    });
    const replay = await request(app).post('/v1/auth/refresh').send({ refreshToken: rt0 });
    expect(replay.status).toBe(401);
    const afterNuke = await request(app).post('/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken });
    expect(afterNuke.status).toBe(401);
  });

  it('reuse-detection: replaying a spent token revokes the whole family', async () => {
    const { res } = await login();
    const rt0 = res.body.refreshToken as string;
    const r1 = await request(app).post('/v1/auth/refresh').send({ refreshToken: rt0 });
    const rt1 = r1.body.refreshToken as string; // the legitimate live token
    await prisma.refreshToken.update({
      where: { tokenHash: sha256(rt0) },
      data: { revokedAt: new Date(Date.now() - REFRESH_REUSE_GRACE_MS - 1000) },
    });
    // Attacker replays the already-spent rt0 → reuse detected → family nuked.
    const replay = await request(app).post('/v1/auth/refresh').send({ refreshToken: rt0 });
    expect(replay.status).toBe(401);
    // The legitimate current token is now revoked too.
    const afterNuke = await request(app).post('/v1/auth/refresh').send({ refreshToken: rt1 });
    expect(afterNuke.status).toBe(401);
  });

  it('POST /v1/auth/refresh-cookie rotates via cookie + re-sets both cookies', async () => {
    const { res } = await login();
    const rt = grindRt(res.headers['set-cookie'] as unknown as string[]);
    expect(rt).toBeTruthy();
    const refreshed = await request(app)
      .post('/v1/auth/refresh-cookie')
      .set('Cookie', `grind_rt=${rt}`);
    expect(refreshed.status).toBe(200);
    const newRt = grindRt(refreshed.headers['set-cookie'] as unknown as string[]);
    expect(newRt).toBeTruthy();
    expect(newRt).not.toBe(rt);
    const joined = (refreshed.headers['set-cookie'] as unknown as string[]).join('; ');
    expect(joined).toMatch(/grind_at=/);
  });

  it('POST /v1/auth/refresh-cookie tolerates an immediate duplicate browser refresh', async () => {
    const { res } = await login();
    const rt = grindRt(res.headers['set-cookie'] as unknown as string[]);
    expect(rt).toBeTruthy();
    const refreshed = await request(app)
      .post('/v1/auth/refresh-cookie')
      .set('Cookie', `grind_rt=${rt}`);
    expect(refreshed.status).toBe(200);
    const newRt = grindRt(refreshed.headers['set-cookie'] as unknown as string[]);
    expect(newRt).toBeTruthy();

    const duplicate = await request(app)
      .post('/v1/auth/refresh-cookie')
      .set('Cookie', `grind_rt=${rt}`);
    expect(duplicate.status).toBe(200);
    // The duplicate re-sets a working cookie, so a tab whose response was lost
    // does not keep the spent one.
    const dupRt = grindRt(duplicate.headers['set-cookie'] as unknown as string[]);
    expect(dupRt).toBeTruthy();

    const stillLive = await request(app)
      .post('/v1/auth/refresh')
      .send({ refreshToken: dupRt });
    expect(stillLive.status).toBe(200);
  });

  it('POST /v1/auth/refresh-cookie with no cookie → 401', async () => {
    const res = await request(app).post('/v1/auth/refresh-cookie');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('no_refresh');
  });

  it('cookie-logout revokes the refresh token (rotation afterwards fails)', async () => {
    const { res } = await login();
    const rt = grindRt(res.headers['set-cookie'] as unknown as string[]);
    const out = await request(app).post('/v1/auth/cookie-logout').set('Cookie', `grind_rt=${rt}`);
    expect(out.status).toBe(200);
    const after = await request(app).post('/v1/auth/refresh-cookie').set('Cookie', `grind_rt=${rt}`);
    expect(after.status).toBe(401);
  });

  it('logout revokes the whole family, even from a stale token', async () => {
    const { user, res } = await login();
    const rt0 = res.body.refreshToken as string;
    const r1 = await request(app).post('/v1/auth/refresh').send({ refreshToken: rt0 });
    expect(r1.status).toBe(200);

    const out = await request(app)
      .post('/v1/auth/logout')
      .set('Authorization', `Bearer ${r1.body.accessToken as string}`)
      .send({ refreshToken: rt0 });
    expect(out.status).toBe(200);

    expect(await prisma.refreshToken.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
    const after = await request(app).post('/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken });
    expect(after.status).toBe(401);
  });
});
