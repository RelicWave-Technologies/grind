/**
 * Set up the dev DB so the M10 approval loop works while the user is signed
 * in as the OWNER (abhishek@emiactech.com):
 *
 *   - OWNER `abhishek@emiactech.com` → LarkIdentity reverted to his real
 *     open_id (the original "Abhishek Verma" identity).
 *   - MEMBER `test-requester@grind.local` → promoted to ADMIN; LarkIdentity
 *     points at Anish Suman's open_id so cards land in the user's actual Lark.
 *
 * After this script, abhishek (OWNER) submitting a manual-time request from
 * the agent results in `approver = test-requester (ADMIN, Lark = Anish)` →
 * card goes to Anish.
 *
 * Run from apps/api:
 *   set -a && source ../../.env && set +a && pnpm tsx scripts/setup-dev-admins.ts
 */
import { config } from 'dotenv';
import * as path from 'node:path';
config({ path: path.resolve(process.cwd(), '../../.env') });

import { prisma } from '@grind/db';

const OWNER_EMAIL = 'abhishek@emiactech.com';
const OWNER_REAL_OPENID = 'ou_51cd8f031e932fdabb7c73a51ffcc1c1'; // "Abhishek Verma" — the actual Lark account behind that email
const ADMIN_EMAIL = 'test-requester@grind.local';
const ANISH_OPENID = 'ou_87565ae857f27a42804a41d39e286b63'; // "Anish Suman"

async function main() {
  const owner = await prisma.user.findUniqueOrThrow({ where: { email: OWNER_EMAIL } });
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: ADMIN_EMAIL } });

  // 1) Promote test-requester → ADMIN (kept in the same workspace as the OWNER).
  if (admin.role !== 'ADMIN') {
    await prisma.user.update({ where: { id: admin.id }, data: { role: 'ADMIN' } });
    console.log(`promoted ${ADMIN_EMAIL} → ADMIN`);
  } else {
    console.log(`${ADMIN_EMAIL} already ADMIN`);
  }

  // 2) Detach any current holder of the Anish open_id (unique constraint), then point the admin at it.
  await prisma.larkIdentity.updateMany({
    where: { openId: ANISH_OPENID, userId: { not: admin.id } },
    data: { openId: `__stash_${Date.now()}_anish` },
  });
  await prisma.larkIdentity.upsert({
    where: { userId: admin.id },
    create: { userId: admin.id, openId: ANISH_OPENID },
    update: { openId: ANISH_OPENID },
  });
  console.log(`${ADMIN_EMAIL} LarkIdentity → ${ANISH_OPENID} (Anish Suman)`);

  // 3) Restore the OWNER's real Lark identity. Detach any other holder of that open_id first.
  await prisma.larkIdentity.updateMany({
    where: { openId: OWNER_REAL_OPENID, userId: { not: owner.id } },
    data: { openId: `__stash_${Date.now()}_owner` },
  });
  await prisma.larkIdentity.upsert({
    where: { userId: owner.id },
    create: { userId: owner.id, openId: OWNER_REAL_OPENID },
    update: { openId: OWNER_REAL_OPENID },
  });
  console.log(`${OWNER_EMAIL} LarkIdentity → ${OWNER_REAL_OPENID} (Abhishek Verma)`);

  // Final summary.
  const final = await prisma.user.findMany({
    where: { workspaceId: owner.workspaceId },
    include: { larkIdentity: true },
    orderBy: { createdAt: 'asc' },
  });
  console.log(
    'workspace users:',
    final.map((u) => ({ email: u.email, role: u.role, openId: u.larkIdentity?.openId ?? null })),
  );

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
