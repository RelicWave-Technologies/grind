import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { seedUser } from './helpers';

const app = buildApp();

async function seed() {
  const admin = await seedUser({ role: 'ADMIN' });
  const member = await prisma.user.create({
    data: {
      workspaceId: admin.workspaceId,
      email: `bday-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`,
      name: 'Bday',
      role: 'MEMBER',
      provisioningStatus: 'ACTIVE',
      passwordHash: 'x'.repeat(60),
    },
  });
  const patch = (birthDate: unknown) =>
    request(app)
      .patch(`/v1/admin/users/${member.id}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ birthDate });
  const stored = async () =>
    (await prisma.user.findUniqueOrThrow({ where: { id: member.id }, select: { birthDate: true } })).birthDate;
  return { patch, stored };
}

describe('PATCH /v1/admin/users/:id birthDate', () => {
  it.each(['2026-02-31', '2025-02-29', '2026-04-31', '2026-13-01', '2026-00-10'])(
    'rejects %s instead of rolling it into another day',
    async (raw) => {
      const { patch, stored } = await seed();
      const res = await patch(raw);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_birth_date');
      expect(await stored()).toBeNull();
    },
  );

  it('accepts a real day, including 29 February in a leap year', async () => {
    const { patch, stored } = await seed();
    expect((await patch('2024-02-29')).status).toBe(200);
    expect((await stored())?.toISOString().slice(0, 10)).toBe('2024-02-29');
  });
});
