import type { PersonFacets, Role } from '@grind/types';

/**
 * The Teams and Roles a dashboard people table filters by (its People · Teams ·
 * Roles facets). Every list endpoint whose rows belong to a person spreads this
 * into the person's Prisma `select` and `personFacets()` into the response, so
 * the team name rides the same query — a join, never a lookup per row.
 */
export const PERSON_FACETS_SELECT = {
  role: true,
  team: { select: { name: true } },
} as const;

export function personFacets(user: { role: Role; team: { name: string } | null }): PersonFacets {
  return { role: user.role, teamName: user.team?.name ?? null };
}
