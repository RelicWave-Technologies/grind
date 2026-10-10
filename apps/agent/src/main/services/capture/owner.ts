import { getTimerService } from '../timer';

/** The signed-in account a local row (screenshot or activity minute) belongs to. */
export interface LocalOwner {
  userId: string;
  workspaceId: string;
}

/**
 * The account the timer is signed in as — every local screenshot and activity
 * minute is scoped to it. Null when signed out or the timer is not up yet.
 */
export function currentOwner(): LocalOwner | null {
  try {
    return getTimerService().currentOwner();
  } catch {
    return null;
  }
}

export function sameOwner(a: LocalOwner | null | undefined, b: LocalOwner | null | undefined): boolean {
  return Boolean(a && b && a.userId === b.userId && a.workspaceId === b.workspaceId);
}

/**
 * Run `claim` once per owner change instead of on every call. Claiming legacy
 * (pre-owner-scoping) rows is a table-wide UPDATE; it only has new work to do
 * when a different account signs in.
 */
export function oncePerOwner(claim: (owner: LocalOwner) => void): (owner: LocalOwner) => void {
  let claimedFor: LocalOwner | null = null;
  return (owner) => {
    if (sameOwner(claimedFor, owner)) return;
    claim(owner);
    claimedFor = { userId: owner.userId, workspaceId: owner.workspaceId };
  };
}
