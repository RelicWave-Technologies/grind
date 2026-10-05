import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import request from 'supertest';
import { prisma } from '@grind/db';
import { attachScope, type ResolvedScope } from '../src/middleware/scope';
import { buildApp } from '../src/app';
import { seedUser } from './helpers';

describe('attachScope runs once per request', () => {
  it('keeps an already-resolved scope instead of resolving it again', async () => {
    const scope: ResolvedScope = {
      scope: 'self', userIds: ['u1'], workspaceId: 'w1', workspaceTimezone: 'UTC', isAdmin: false, capabilities: [],
    };
    // 'u-missing' does not exist: a second lookup would answer 401.
    const req = { user: { sub: 'u-missing', ws: 'w-missing', role: 'MEMBER' }, scope } as unknown as Request;
    const status = vi.fn(() => ({ json: vi.fn() }));
    const next = vi.fn();
    await attachScope(req, { status } as unknown as Response, next);
    expect(next).toHaveBeenCalledWith();
    expect(status).not.toHaveBeenCalled();
    expect(req.scope).toBe(scope);
  });

  it('a /v1/admin sub-router resolves the scope once, not twice', async () => {
    const app = buildApp();
    const admin = await seedUser({ role: 'ADMIN' });
    // Prisma delegates are proxies: spying replaces the method for the rest of
    // this file, so this stays the last test and calls through explicitly.
    const original = prisma.user.findFirst.bind(prisma.user);
    const findFirst = vi.spyOn(prisma.user, 'findFirst').mockImplementation(((args: never) => original(args)) as never);
    const res = await request(app)
      .get('/v1/admin/workspace-policy')
      .set('Authorization', `Bearer ${admin.accessToken}`);
    expect(res.status).toBe(200);
    const scopeLookups = findFirst.mock.calls.filter(([args]) => {
      const where = (args as { where?: Record<string, unknown> } | undefined)?.where;
      return where?.id === admin.userId && 'deactivatedAt' in where;
    });
    expect(scopeLookups).toHaveLength(1);
  });
});
