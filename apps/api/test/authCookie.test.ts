import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { hashPassword } from '../src/lib/password';

/**
 * Dashboard auth flow: /v1/auth/login sets a grind_at httpOnly cookie that
 * subsequent requests can use INSTEAD of the Authorization header. This
 * lets the React SPA call the API with `credentials: 'include'` and never
 * touch the token directly.
 *
 * Existing /v1/auth/login JSON behaviour is preserved (agent keeps working).
 */

const app = buildApp();

let counter = 0;
async function seed(role: 'ADMIN' | 'MANAGER' | 'MEMBER' = 'MEMBER') {
  counter += 1;
  const ws = await prisma.workspace.create({ data: { name: `WS-auth-cookie-${counter}` } });
  const password = 'sekret-password-' + counter;
  const user = await prisma.user.create({
    data: {
      workspaceId: ws.id,
      email: `cookie-${Date.now()}-${counter}@test.local`,
      name: `Cookie User ${counter}`,
      role,
      passwordHash: await hashPassword(password),
    },
  });
  return { ws, user, password };
}

describe('Auth cookie flow', () => {
  it('POST /v1/auth/login returns JSON + sets grind_at httpOnly cookie', async () => {
    const s = await seed();
    const res = await request(app).post('/v1/auth/login').send({ email: s.user.email, password: s.password });
    expect(res.status).toBe(200);
    // Body still has accessToken so the agent works unchanged.
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.user.email).toBe(s.user.email);
    // Cookie present.
    const setCookie = res.headers['set-cookie'];
    expect(setCookie).toBeTruthy();
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie);
    expect(cookieHeader).toMatch(/grind_at=/);
    expect(cookieHeader.toLowerCase()).toContain('httponly');
    expect(cookieHeader.toLowerCase()).toContain('samesite=lax');
  });

  it('GET /v1/auth/me works via the cookie alone (no Authorization header)', async () => {
    const s = await seed();
    const login = await request(app).post('/v1/auth/login').send({ email: s.user.email, password: s.password });
    const cookies = login.headers['set-cookie']!;
    const cookieValue = Array.isArray(cookies) ? cookies.join('; ') : String(cookies);
    const me = await request(app).get('/v1/auth/me').set('Cookie', cookieValue);
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(s.user.id);
  });

  it('GET /v1/auth/me returns 401 with no cookie or header', async () => {
    const res = await request(app).get('/v1/auth/me');
    expect(res.status).toBe(401);
  });

  it('Authorization header still works (cookie not required)', async () => {
    const s = await seed();
    const login = await request(app).post('/v1/auth/login').send({ email: s.user.email, password: s.password });
    const token = login.body.accessToken as string;
    const me = await request(app).get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
  });

  it('Header takes precedence over cookie when both are present', async () => {
    const a = await seed();
    const b = await seed();
    const loginA = await request(app).post('/v1/auth/login').send({ email: a.user.email, password: a.password });
    const loginB = await request(app).post('/v1/auth/login').send({ email: b.user.email, password: b.password });
    // Send A's cookie + B's header — header should win.
    const aCookie = Array.isArray(loginA.headers['set-cookie']) ? loginA.headers['set-cookie']!.join('; ') : String(loginA.headers['set-cookie']);
    const me = await request(app)
      .get('/v1/auth/me')
      .set('Cookie', aCookie)
      .set('Authorization', `Bearer ${loginB.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(b.user.id);
  });

  it('POST /v1/auth/cookie-logout clears the cookie', async () => {
    const s = await seed();
    const login = await request(app).post('/v1/auth/login').send({ email: s.user.email, password: s.password });
    const cookieValue = Array.isArray(login.headers['set-cookie']) ? login.headers['set-cookie']!.join('; ') : String(login.headers['set-cookie']);
    const out = await request(app).post('/v1/auth/cookie-logout').set('Cookie', cookieValue);
    expect(out.status).toBe(200);
    const cleared = Array.isArray(out.headers['set-cookie']) ? out.headers['set-cookie']!.join('; ') : String(out.headers['set-cookie']);
    expect(cleared.toLowerCase()).toMatch(/grind_at=;|grind_at=""/);
  });
});
