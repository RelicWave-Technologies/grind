import { prisma } from '@grind/db';
import { hashPassword } from '../src/lib/password';
import { signAccessToken } from '../src/lib/jwt';

export interface SeededUser {
  workspaceId: string;
  userId: string;
  projectId: string;
  taskId: string;
  accessToken: string;
}

let counter = 0;

/** Seed a fresh workspace + user + project + task and return an access token. */
export async function seedUser(opts?: { role?: 'ADMIN' | 'MANAGER' | 'MEMBER' }): Promise<SeededUser> {
  counter += 1;
  const ws = await prisma.workspace.create({ data: { name: `WS ${counter}` } });
  const user = await prisma.user.create({
    data: {
      workspaceId: ws.id,
      email: `user${counter}-${Date.now()}@test.local`,
      name: `User ${counter}`,
      role: opts?.role ?? 'MEMBER',
      passwordHash: await hashPassword('password123'),
    },
  });
  const project = await prisma.project.create({ data: { workspaceId: ws.id, name: `Project ${counter}` } });
  const task = await prisma.task.create({ data: { projectId: project.id, name: `Task ${counter}` } });
  const accessToken = signAccessToken({ sub: user.id, ws: ws.id, role: user.role });
  return { workspaceId: ws.id, userId: user.id, projectId: project.id, taskId: task.id, accessToken };
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
