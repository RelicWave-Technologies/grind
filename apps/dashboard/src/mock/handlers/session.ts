/** Auth, profile, workspace directory, Lark tasks, installer downloads. */
import { roleCapabilities } from '@grind/types';
import type { Me } from '../../lib/auth';
import { TZ } from '../clock';
import type { DbUser, MockDb } from '../db';
import { isActive, managedTeamIds, profileFor } from '../derive';
import { fail, get, post, raw, type Ctx } from '../http';
import { ROLE_PERSONA, TASKS, WORKSPACE } from '../people';
import { getSettings, updateSettings } from '../settings';
import { teamKeyOf } from '../activity';
import type { Role } from '@grind/types';

/** The signed-in user for a dev-panel role. */
export function resolveMe(db: MockDb, role: Role): DbUser {
  const preferred = db.users.find((u) => u.id === ROLE_PERSONA[role] && isActive(u));
  return (
    preferred ??
    db.users.find((u) => u.role === role && isActive(u) && u.provisioningStatus === 'ACTIVE') ??
    db.users.find((u) => isActive(u) && u.provisioningStatus === 'ACTIVE')!
  );
}

export function meDto(ctx: Ctx): Me {
  const u = ctx.me;
  const managed = ctx.empty ? [] : managedTeamIds(ctx, u.id);
  const managedTeam = ctx.db.teams.find((t) => t.id === managed[0]);
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    activityRoleTitle: u.activityRoleTitle,
    displayRole: u.role,
    capabilities: roleCapabilities(u.role),
    workspaceId: WORKSPACE.id,
    workspaceTimezone: TZ,
    teamId: ctx.empty ? null : u.teamId,
    managerId: ctx.empty ? null : u.managerId,
    managesTeamId: managedTeam?.id ?? null,
    managesTeamName: managedTeam?.name ?? null,
    provisioningStatus: u.provisioningStatus,
    avatarUrl: u.avatarUrl,
  };
}

export function registerSession(): void {
  get(
    '/v1/auth/me',
    (_req, ctx) => {
      if (getSettings().signedOut) fail(401, 'unauthorized');
      return { user: meDto(ctx) };
    },
    { public: true },
  );

  post(
    '/v1/auth/refresh-cookie',
    () => {
      if (getSettings().signedOut) fail(401, 'unauthorized');
      return { ok: true };
    },
    { public: true },
  );

  post(
    '/v1/auth/cookie-logout',
    () => {
      updateSettings({ signedOut: true });
      return { ok: true };
    },
    { public: true },
  );

  // Dev-only password form (VITE_ENABLE_PASSWORD_LOGIN) — any credentials work.
  post(
    '/v1/auth/login',
    () => {
      updateSettings({ signedOut: false });
      return { ok: true };
    },
    { public: true },
  );

  get('/v1/profile/me', (_req, ctx) => profileFor(ctx, ctx.me));

  get('/v1/workspace/users', (_req, ctx) => ({
    users: (ctx.empty ? [ctx.me] : ctx.db.users.filter((u) => isActive(u) && u.provisioningStatus === 'ACTIVE')).map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      avatarUrl: u.avatarUrl,
      role: u.role,
    })),
  }));

  get('/v1/lark/my-tasks', (_req, ctx) => {
    if (ctx.empty) return { tasks: [] };
    const team = teamKeyOf(ctx.me.teamId);
    const mine = TASKS.filter((t) => t.team === null || t.team === team || ctx.me.role === 'ADMIN');
    return { tasks: mine.map((t) => ({ guid: t.guid, summary: t.summary })) };
  });

  // Normally a top-level navigation (served by the Vite mock plugin); here
  // for completeness if anything fetches it.
  get(
    '/v1/downloads/agent/:platform',
    (req) =>
      raw(
        `Timo desktop agent (${req.params.platform}) — mock download. The real installer is served by the API.\n`,
        'text/plain',
        `Timo-${req.params.platform}-mock.txt`,
      ),
    { public: true },
  );
}
