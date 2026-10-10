import type { PrismaClient } from '@grind/db';
import { normalizeEmail, type LarkProfile } from './profile';

/**
 * The task-connect callback only proves that SOMEBODY authorized a Lark account
 * and came back with a state Timo signed for a given user. Without this check,
 * a user who forwards their authorize link (or is tricked into opening someone
 * else's) gets that other person's Lark tokens stored against their Timo
 * account — every task list, task creation and identity lookup then runs as
 * the wrong person.
 *
 * So the Lark account behind the freshly-exchanged token must be the one this
 * Timo user already is:
 *   - a linked LarkIdentity (Lark login, or an earlier connect) must match
 *     open_id exactly — open_id is the key LarkIdentity is unique on;
 *   - with no link yet, the Lark profile's email must be this user's email
 *     (the same rule `resolveIdentity` uses to link by email), and the open_id
 *     must not already belong to another Timo user.
 *
 * Fails closed: a profile Lark would not return counts as a mismatch, and no
 * token is stored.
 */
export class LarkIdentityMismatchError extends Error {
  constructor(readonly reason: 'profile_unavailable' | 'open_id_mismatch' | 'email_mismatch' | 'open_id_taken') {
    super(`lark identity mismatch: ${reason}`);
    this.name = 'LarkIdentityMismatchError';
  }
}

type IdentityDb = Pick<PrismaClient, 'larkIdentity' | 'user'>;

export async function assertLarkProfileBelongsToUser(
  db: IdentityDb,
  userId: string,
  profile: LarkProfile | null,
): Promise<void> {
  if (!profile?.openId) throw new LarkIdentityMismatchError('profile_unavailable');

  const linked = await db.larkIdentity.findUnique({ where: { userId }, select: { openId: true } });
  if (linked) {
    if (linked.openId !== profile.openId) throw new LarkIdentityMismatchError('open_id_mismatch');
    return;
  }

  const owner = await db.larkIdentity.findUnique({ where: { openId: profile.openId }, select: { userId: true } });
  if (owner && owner.userId !== userId) throw new LarkIdentityMismatchError('open_id_taken');

  const user = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
  const userEmail = normalizeEmail(user?.email);
  const larkEmail = normalizeEmail(profile.email);
  if (!userEmail || !larkEmail || userEmail !== larkEmail) throw new LarkIdentityMismatchError('email_mismatch');
}
