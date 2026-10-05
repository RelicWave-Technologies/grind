import crypto from 'node:crypto';
import { prisma, type Prisma } from '@grind/db';
import { Role as RoleSchema, type Role } from '@grind/types';
import { env } from '../env';
import { signAccessToken } from './jwt';

export type IssuedRefresh = {
  refreshToken: string;
  expiresAt: Date;
  familyId: string;
};

/**
 * How long a just-spent refresh token may still be replayed without being
 * treated as theft. Two clients legitimately do this: a browser whose tabs
 * refresh at the same moment, and any client whose rotation response was lost
 * (5xx, dropped socket, timeout) and who retries with the token it still holds.
 * Inside this window, a replay whose successor has never been used rotates
 * again from it; see {@link rotateRefreshToken}.
 */
export const REFRESH_REUSE_GRACE_MS = 2 * 60_000;

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function newSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function refreshExpiry(): Date {
  return new Date(Date.now() + env.JWT_REFRESH_TTL_SECONDS * 1000);
}

/**
 * Mint a brand-new refresh token that starts its own rotation family. Used on
 * fresh logins (Lark callback, agent exchange, dev password). Subsequent
 * rotations go through {@link rotateRefreshToken} and stay in the same family.
 */
export async function issueRefreshToken(userId: string, deviceName?: string): Promise<IssuedRefresh> {
  const refreshToken = newSecret();
  const tokenHash = sha256(refreshToken);
  const expiresAt = refreshExpiry();
  // A fresh login starts its own family; familyId is set to the row id post-create.
  const row = await prisma.refreshToken.create({
    data: { userId, tokenHash, deviceName: deviceName ?? null, familyId: 'pending', expiresAt },
  });
  await prisma.refreshToken.update({ where: { id: row.id }, data: { familyId: row.id } });
  return { refreshToken, expiresAt, familyId: row.id };
}

/**
 * Log out: revoke the presented token's whole rotation family, not just the
 * one token. Revoking only the presented token left any sibling a lost-response
 * re-rotation had minted alive, and a logout from a stale token revoked
 * nothing at all.
 */
export async function revokeRefreshToken(refreshToken: string): Promise<boolean> {
  const tokenHash = sha256(refreshToken);
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash }, select: { familyId: true } });
  if (!row) return false;
  const revoked = await prisma.refreshToken.updateMany({
    where: { familyId: row.familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return revoked.count > 0;
}

export type RotateResult =
  | { ok: true; accessToken: string; refreshToken: string; expiresAt: Date }
  | { ok: false; reason: 'invalid' | 'expired' | 'reuse' | 'reuse_grace' | 'stale_role' | 'deactivated' };

type Tx = Prisma.TransactionClient;

type RotatableUser = { workspaceId: string; role: string; deactivatedAt: Date | null };

/** May this user be issued a fresh session at all? */
function sessionGate(user: RotatableUser): { ok: true; role: Role } | { ok: false; reason: 'deactivated' | 'stale_role' } {
  // A suspended account must not be able to mint itself a fresh session.
  // Without this the flag stopped only NEW logins: an agent already holding a
  // refresh token rotated it forever.
  if (user.deactivatedAt) return { ok: false, reason: 'deactivated' };
  const parsedRole = RoleSchema.safeParse(user.role);
  if (!parsedRole.success) return { ok: false, reason: 'stale_role' };
  return { ok: true, role: parsedRole.data };
}

/** Mint the next token in `parent`'s family and link `linkFrom` rows to it. */
async function mintSuccessor(
  tx: Tx,
  parent: { userId: string; deviceName: string | null; familyId: string; user: RotatableUser },
  role: Role,
  linkFrom: string[],
): Promise<RotateResult> {
  const refreshToken = newSecret();
  const expiresAt = refreshExpiry();
  const successor = await tx.refreshToken.create({
    data: {
      userId: parent.userId,
      tokenHash: sha256(refreshToken),
      deviceName: parent.deviceName,
      familyId: parent.familyId,
      expiresAt,
    },
    select: { id: true },
  });
  await tx.refreshToken.updateMany({ where: { id: { in: linkFrom } }, data: { replacedById: successor.id } });
  const accessToken = signAccessToken({ sub: parent.userId, ws: parent.user.workspaceId, role });
  return { ok: true, accessToken, refreshToken, expiresAt };
}

/**
 * Single-use rotation with reuse detection. Validates the presented token,
 * revokes it, and mints a successor in the SAME family — all in one
 * transaction, and the revoke is conditional on the token still being live, so
 * two parallel rotations of one token can never both mint a successor: the
 * loser gets `reuse_grace` and keeps whatever the winner stored.
 *
 * Presenting an ALREADY-SPENT token is judged from what the database recorded:
 *
 *   - spent within {@link REFRESH_REUSE_GRACE_MS} and its successor has never
 *     been used: the caller never received that successor (lost response, or a
 *     second tab). Retire the unused successor and rotate again from here. A
 *     thief replaying the token gains nothing durable: the legitimate client's
 *     next use of the retired successor is itself a replay, outside the window
 *     or with a used successor, and revokes the family.
 *   - spent within the window but the family has already moved on: benign
 *     browser concurrency — `reuse_grace`, nothing revoked, nothing minted.
 *   - anything else is reuse: revoke every live token in the family.
 *
 * The rule lives in the database, so it holds across restarts and instances.
 */
export async function rotateRefreshToken(presented: string): Promise<RotateResult> {
  const tokenHash = sha256(presented);

  return prisma.$transaction(async (tx): Promise<RotateResult> => {
    const row = await tx.refreshToken.findUnique({ where: { tokenHash }, include: { user: true } });
    if (!row) return { ok: false, reason: 'invalid' };
    const now = new Date();

    if (row.revokedAt) {
      const withinGrace = now.getTime() - row.revokedAt.getTime() <= REFRESH_REUSE_GRACE_MS;
      if (withinGrace && row.replacedById) {
        const successor = await tx.refreshToken.findUnique({
          where: { id: row.replacedById },
          select: { id: true, revokedAt: true, expiresAt: true },
        });
        if (successor && !successor.revokedAt && successor.expiresAt > now) {
          const gate = sessionGate(row.user);
          if (!gate.ok) return gate;
          const retired = await tx.refreshToken.updateMany({
            where: { id: successor.id, revokedAt: null },
            data: { revokedAt: now },
          });
          // The successor was spent while we looked: someone else holds the
          // family now. Benign, but there is nothing to hand back.
          if (retired.count !== 1) return { ok: false, reason: 'reuse_grace' };
          // Link both the presented token and the retired successor forward, so
          // whichever of the two the client ends up holding can still recover.
          return mintSuccessor(tx, row, gate.role, [row.id, successor.id]);
        }
      }
      if (withinGrace) {
        const live = await tx.refreshToken.findFirst({
          where: { familyId: row.familyId, revokedAt: null },
          select: { id: true },
        });
        if (live) return { ok: false, reason: 'reuse_grace' };
      }
      // Reuse detected → nuke the whole family.
      await tx.refreshToken.updateMany({
        where: { familyId: row.familyId, revokedAt: null },
        data: { revokedAt: now },
      });
      return { ok: false, reason: 'reuse' };
    }
    if (row.expiresAt < now) return { ok: false, reason: 'expired' };

    const gate = sessionGate(row.user);
    if (!gate.ok) return gate;

    // Conditional on still being live: a parallel rotation that got here first
    // has already spent it, and this one must not mint a second successor.
    const spent = await tx.refreshToken.updateMany({
      where: { id: row.id, revokedAt: null },
      data: { revokedAt: now },
    });
    if (spent.count !== 1) return { ok: false, reason: 'reuse_grace' };
    return mintSuccessor(tx, row, gate.role, [row.id]);
  });
}
