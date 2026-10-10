/**
 * Prisma error codes, duck-typed: the runtime Prisma error classes are not
 * re-exported from @grind/db (see its index.ts), so a code check is the one
 * reliable test.
 */
export function prismaErrorCode(err: unknown): string | undefined {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

/** A unique constraint said no (P2002) — usually a concurrent create of the same row. */
export function isUniqueViolation(err: unknown): boolean {
  return prismaErrorCode(err) === 'P2002';
}
