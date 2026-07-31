import { PrismaClient } from '@prisma/client';

export type { Prisma } from '@prisma/client';
export { PrismaClient } from '@prisma/client';

export interface PrismaFactoryOptions {
  datasourceUrl?: string;
  logQueries?: boolean;
}

function build(options: PrismaFactoryOptions): PrismaClient {
  return new PrismaClient({
    ...(options.datasourceUrl ? { datasourceUrl: options.datasourceUrl } : {}),
    log: options.logQueries
      ? [
          { emit: 'event', level: 'query' },
          { emit: 'stdout', level: 'warn' },
          { emit: 'stdout', level: 'error' },
        ]
      : [
          { emit: 'stdout', level: 'warn' },
          { emit: 'stdout', level: 'error' },
        ],
    errorFormat: 'minimal',
  });
}

// Next.js dev and tsx watch reload modules on every change. Without this the
// process accumulates one connection pool per reload and exhausts Postgres.
const globalForPrisma = globalThis as unknown as { __arenaPrisma?: PrismaClient };

export function getPrismaClient(options: PrismaFactoryOptions = {}): PrismaClient {
  if (process.env.NODE_ENV === 'production') {
    return build(options);
  }
  globalForPrisma.__arenaPrisma ??= build(options);
  return globalForPrisma.__arenaPrisma;
}

export async function disconnectPrisma(client: PrismaClient): Promise<void> {
  await client.$disconnect();
}

/** Lightweight readiness probe used by the /health endpoints. */
export async function pingDatabase(client: PrismaClient): Promise<boolean> {
  try {
    await client.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
