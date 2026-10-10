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

/** Prisma's pool timeout, interactive-transaction timeout, write conflict / deadlock. */
const TRANSIENT_PRISMA_CODES = new Set(['P2024', 'P2028', 'P2034']);
/** Postgres deadlock_detected and serialization_failure, as raw queries report them. */
const TRANSIENT_PG_CODES = new Set(['40P01', '40001']);

/**
 * The database was too busy, not wrong: the same request can succeed in a few
 * seconds. Raw queries wrap the Postgres code in P2010's meta.
 */
export function isTransientDbError(err: unknown): boolean {
  const code = prismaErrorCode(err);
  if (code && (TRANSIENT_PRISMA_CODES.has(code) || TRANSIENT_PG_CODES.has(code))) return true;
  const meta = typeof err === 'object' && err !== null ? (err as { meta?: { code?: unknown } }).meta : undefined;
  return typeof meta?.code === 'string' && TRANSIENT_PG_CODES.has(meta.code);
}
