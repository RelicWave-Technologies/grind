/**
 * The server closed an entry because it stopped hearing from this agent — its
 * lease lapsed, or a newer timer superseded the silent one — not because
 * anyone decided the work ended. Only the agent knows the real end, so it
 * answers with its own copy instead of accepting the cut.
 *
 * The server keeps its own copy of this rule (`isServerFinalized` in
 * apps/api/src/routes/timeEntries.ts); this is the agent's one copy.
 */
export function isClosedForSilence(closeReason: string | null | undefined): boolean {
  return closeReason === 'LEASE_EXPIRED' || closeReason === 'SUPERSEDED';
}
