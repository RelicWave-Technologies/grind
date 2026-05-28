import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __grindPrisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  global.__grindPrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  global.__grindPrisma = prisma;
}

// Type-only re-export: a runtime `export *` from the (CommonJS) Prisma client
// breaks Node's named-export detection for consumers loaded via tsx, making the
// `prisma` export above invisible. Types are erased, so this is safe.
export type * from '@prisma/client';
