/**
 * Dev helper: mint (or reset) a MEMBER account with a KNOWN password in the
 * primary admin's workspace, so you can sign in as a team member and exercise the
 * MEMBER role end-to-end. As a MEMBER the dashboard lands on /me-today and the
 * admin surfaces (overview / team / approvals / flags / users / …) are blocked
 * (self-scoped token → 403).
 *
 * Run from apps/api:
 *   set -a && source ../../.env && set +a && pnpm tsx scripts/make-member.ts
 *
 * Then sign in as:   member@grind.local  /  member1234
 *   - Dashboard: use an INCOGNITO / separate browser profile (the session is an
 *     httpOnly cookie, so logging in here would replace your admin session).
 *   - Agent: sign out, then log in on the agent's Login screen.
 */
import { config } from 'dotenv';
import * as path from 'node:path';
config({ path: path.resolve(process.cwd(), '../../.env') });

import { prisma } from '@grind/db';
import { hashPassword } from '../src/lib/password';

const PRIMARY_ADMIN_EMAIL = 'abhishek@emiactech.com';
const MEMBER_EMAIL = 'member@grind.local';
const MEMBER_PASSWORD = 'member1234';

async function main() {
  const primaryAdmin = await prisma.user.findUniqueOrThrow({ where: { email: PRIMARY_ADMIN_EMAIL } });
  const passwordHash = await hashPassword(MEMBER_PASSWORD);

  const member = await prisma.user.upsert({
    where: { email: MEMBER_EMAIL },
    create: {
      workspaceId: primaryAdmin.workspaceId,
      email: MEMBER_EMAIL,
      name: 'Test Member',
      role: 'MEMBER',
      passwordHash,
    },
    update: { role: 'MEMBER', passwordHash, deactivatedAt: null, workspaceId: primaryAdmin.workspaceId },
    select: { id: true, email: true, name: true, role: true, workspaceId: true },
  });

  console.log('✓ MEMBER ready — sign in with:');
  console.log({ email: MEMBER_EMAIL, password: MEMBER_PASSWORD, role: member.role, workspaceId: member.workspaceId });
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
