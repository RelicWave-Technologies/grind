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

export * from '@prisma/client';
