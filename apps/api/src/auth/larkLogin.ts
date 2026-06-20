import crypto from 'node:crypto';
import { prisma, type Prisma } from '@grind/db';
import { env } from '../env';
import { normalizeEmail, type LarkProfile } from '../lark/profile';

/** Unique-constraint violation, duck-typed (the runtime Prisma class isn't
 *  re-exported from @grind/db — see its index.ts). Matches the convention in
 *  routes/admin.ts + payroll/scheduler.ts. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

/**
 * Lark-login identity + provisioning service.
 *
 * Identity is keyed on the Lark `open_id` (stable, app-scoped). On every login
 * we sync the stable profile fields (name/avatar/email). Org hierarchy
 * (team/manager/role) is Grind-owned and never read from Lark.
 *
 * Provisioning:
 *  - bootstrap admin email → created (or promoted) ACTIVE ADMIN
 *  - everyone else → PENDING MEMBER until an admin completes setup or activates them
 */

export type ResolvedLoginUser = {
  id: string;
  email: string;
  name: string;
  role: 'ADMIN' | 'MANAGER' | 'MEMBER';
  workspaceId: string;
  teamId: string | null;
  shiftId: string | null;
  managerId: string | null;
  provisioningStatus: 'PENDING' | 'ACTIVE';
  avatarUrl: string | null;
  deactivatedAt: Date | null;
};

const LOGIN_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  workspaceId: true,
  teamId: true,
  shiftId: true,
  managerId: true,
  provisioningStatus: true,
  avatarUrl: true,
  deactivatedAt: true,
} as const;

/** Parsed, normalized bootstrap-admin allowlist from env (case-insensitive). */
export function bootstrapAdminEmails(): string[] {
  return (env.LARK_BOOTSTRAP_ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => normalizeEmail(e))
    .filter((e): e is string => e !== null);
}

function isBootstrapEmail(email: string): boolean {
  return bootstrapAdminEmails().includes(email);
}

/**
 * Resolve (and provision if needed) the Grind user for a Lark profile. Caller
 * must have already rejected a profile with no email. Idempotent under
 * concurrent first-logins: a unique-constraint race re-runs as a find.
 */
export async function resolveUser(profile: LarkProfile): Promise<ResolvedLoginUser> {
  // Normalize defensively — don't trust the caller to have lowercased/trimmed.
  const email = normalizeEmail(profile.email);
  if (!email) throw new Error('resolveUser requires a non-null email');
  profile = { ...profile, email };

  // 1. Known Lark identity → the common path.
  const byOpenId = await prisma.larkIdentity.findUnique({ where: { openId: profile.openId } });
  if (byOpenId) return syncAndReturn(byOpenId.userId, profile);

  // 2. Existing user by email (pre-created shell or a future non-empty DB):
  //    link the Lark identity to them.
  const byEmail = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (byEmail) {
    await linkIdentity(byEmail.id, profile);
    return syncAndReturn(byEmail.id, profile);
  }

  // 3. Brand-new user — create with the right provisioning state.
  try {
    return await createUser(profile, email);
  } catch (err) {
    // Lost a create race (another request created the same open_id / email):
    // fall back to a find so both requests converge on one user.
    if (isUniqueViolation(err)) {
      const again = await prisma.larkIdentity.findUnique({ where: { openId: profile.openId } });
      if (again) return syncAndReturn(again.userId, profile);
      const byEmailAgain = await prisma.user.findUnique({ where: { email }, select: { id: true } });
      if (byEmailAgain) return syncAndReturn(byEmailAgain.id, profile);
    }
    throw err;
  }
}

async function createUser(profile: LarkProfile, email: string): Promise<ResolvedLoginUser> {
  return prisma.$transaction(async (tx) => {
    // Idempotent single workspace — concurrent bootstraps can't duplicate it.
    await tx.workspace.upsert({
      where: { id: env.WORKSPACE_ID },
      create: { id: env.WORKSPACE_ID, name: 'Workspace' },
      update: {},
    });
    // Bootstrap admin = a configured bootstrap email, OR the very first user in
    // an empty workspace (so a fresh install always has someone who can grant
    // roles, even before LARK_BOOTSTRAP_ADMIN_EMAILS is set).
    const bootstrap = isBootstrapEmail(email) || (await tx.user.count()) === 0;
    const user = await tx.user.create({
      data: {
        workspaceId: env.WORKSPACE_ID,
        email,
        name: profile.name || email,
        avatarUrl: profile.avatarUrl,
        role: bootstrap ? 'ADMIN' : 'MEMBER',
        provisioningStatus: bootstrap ? 'ACTIVE' : 'PENDING',
        passwordHash: null,
        larkIdentity: {
          create: { openId: profile.openId, unionId: profile.unionId },
        },
      },
      select: LOGIN_USER_SELECT,
    });
    return user as ResolvedLoginUser;
  });
}

async function linkIdentity(userId: string, profile: LarkProfile): Promise<void> {
  await prisma.larkIdentity.upsert({
    where: { userId },
    create: { userId, openId: profile.openId, unionId: profile.unionId },
    update: { openId: profile.openId, unionId: profile.unionId },
  });
}

/**
 * Sync stable profile fields, apply bootstrap promotion, and return the user.
 * Profile-field updates are best-effort: an email collision (another user holds
 * that email) is swallowed — open_id remains the source of truth, so login
 * still succeeds with the old email.
 */
async function syncAndReturn(userId: string, profile: LarkProfile): Promise<ResolvedLoginUser> {
  const current = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: LOGIN_USER_SELECT,
  });

  const promote = profile.email && isBootstrapEmail(profile.email) &&
    (current.role !== 'ADMIN' || current.provisioningStatus !== 'ACTIVE');
  const activateCompletedSetup =
    current.provisioningStatus === 'PENDING' &&
    !current.deactivatedAt &&
    Boolean(current.teamId && current.shiftId);

  const data: Prisma.UserUpdateInput = {
    name: profile.name || current.name,
    avatarUrl: profile.avatarUrl,
    ...(promote
      ? { role: 'ADMIN', provisioningStatus: 'ACTIVE' }
      : activateCompletedSetup
        ? { provisioningStatus: 'ACTIVE' }
        : {}),
  };
  // Only touch email when it actually changed, and isolate its unique-collision
  // risk so a clash doesn't fail the whole login.
  if (profile.email && profile.email !== current.email) {
    try {
      const updated = await prisma.user.update({
        where: { id: userId },
        data: { ...data, email: profile.email },
        select: LOGIN_USER_SELECT,
      });
      return updated as ResolvedLoginUser;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // email collision — keep the old email, still apply the other fields.
    }
  }
  const updated = await prisma.user.update({ where: { id: userId }, data, select: LOGIN_USER_SELECT });
  return updated as ResolvedLoginUser;
}

// --- Agent one-time deep-link codes (PKCE-bound, single-use) ----------------

const AGENT_CODE_TTL_MS = 120_000;

export class AgentCodeError extends Error {
  constructor(public readonly code: 'code_invalid' | 'pkce_mismatch') {
    super(code);
    this.name = 'AgentCodeError';
  }
}

function sha256hex(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** Mint a single-use deep-link code bound to the agent's PKCE challenge. */
export async function createAgentAuthCode(userId: string, challenge: string): Promise<string> {
  const code = crypto.randomBytes(32).toString('base64url');
  await prisma.agentAuthCode.create({
    data: {
      codeHash: sha256hex(code),
      userId,
      challenge,
      expiresAt: new Date(Date.now() + AGENT_CODE_TTL_MS),
    },
  });
  return code;
}

/**
 * Redeem a one-time code for the userId, enforcing single-use + TTL + PKCE.
 * The PKCE check blocks another local app that intercepted the grind:// URL —
 * it can't redeem without the agent's verifier.
 */
export async function redeemAgentAuthCode(code: string, codeVerifier: string): Promise<string> {
  const row = await prisma.agentAuthCode.findUnique({ where: { codeHash: sha256hex(code) } });
  if (!row || row.consumedAt || row.expiresAt.getTime() <= Date.now()) {
    throw new AgentCodeError('code_invalid');
  }
  const computed = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  if (computed !== row.challenge) throw new AgentCodeError('pkce_mismatch');
  // Atomic single-use: only the request that flips consumedAt from null wins.
  const claimed = await prisma.agentAuthCode.updateMany({
    where: { id: row.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (claimed.count !== 1) throw new AgentCodeError('code_invalid');
  return row.userId;
}
