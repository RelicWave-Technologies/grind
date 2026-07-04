import { prisma } from '@grind/db';
import { hashPassword } from '../src/lib/password';
import { signAccessToken } from '../src/lib/jwt';

export interface SeededUser {
  workspaceId: string;
  userId: string;
  accessToken: string;
}

let counter = 0;

/** Seed a fresh workspace + user and return an access token. */
export async function seedUser(opts?: { role?: 'ADMIN' | 'MANAGER' | 'MEMBER' }): Promise<SeededUser> {
  counter += 1;
  const ws = await prisma.workspace.create({ data: { name: `WS ${counter}` } });
  const user = await prisma.user.create({
    data: {
      workspaceId: ws.id,
      email: `user${counter}-${Date.now()}@test.local`,
      name: `User ${counter}`,
      role: opts?.role ?? 'MEMBER',
      provisioningStatus: 'ACTIVE',
      passwordHash: await hashPassword('password123'),
    },
  });
  const accessToken = signAccessToken({ sub: user.id, ws: ws.id, role: user.role });
  return { workspaceId: ws.id, userId: user.id, accessToken };
}

export async function createManagedTeam(args: {
  workspaceId: string;
  name: string;
  managerId: string;
}) {
  const team = await prisma.team.create({
    data: { workspaceId: args.workspaceId, name: args.name },
  });
  await prisma.teamManager.create({
    data: { workspaceId: args.workspaceId, teamId: team.id, userId: args.managerId },
  });
  await prisma.user.updateMany({
    where: { id: args.managerId, role: { not: 'ADMIN' } },
    data: { role: 'MANAGER', teamId: team.id, managerId: null },
  });
  return team;
}

let ulidCounter = 0;
/** Deterministic, lexicographically-increasing fake ULID for tests. */
export function fakeUlid(prefix = 'id'): string {
  ulidCounter += 1;
  return `${prefix}_${String(ulidCounter).padStart(10, '0')}`;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}
