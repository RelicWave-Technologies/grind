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

/**
 * A fixed-offset zone in which "now" is around midday.
 *
 * The overview endpoint buckets by the WORKSPACE timezone, and these tests
 * seed their segments relative to `Date.now()`. Left on the schema's default
 * of UTC, every one of them breaks when the suite happens to run within ~90
 * minutes of UTC midnight — the seeded work lands in yesterday and the day's
 * totals come back near zero. That is exactly what CI hit at 00:36 UTC.
 *
 * Anchoring the workspace to a zone where the current instant is midday keeps
 * the whole lookback inside one local day whatever time the suite runs. The
 * `Etc/GMT` zones carry an inverted sign (`Etc/GMT-12` is UTC+12) and have no
 * DST, so the offset stays put for the length of a test run.
 */
export function midDayTimeZone(now = new Date()): string {
  const offsetHours = 12 - now.getUTCHours();
  if (offsetHours === 0) return 'Etc/GMT';
  return offsetHours > 0 ? `Etc/GMT-${offsetHours}` : `Etc/GMT+${-offsetHours}`;
}
