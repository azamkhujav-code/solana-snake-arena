import { disconnectPrisma, getPrismaClient, type PrismaClient } from '@arena/db';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

import { config } from '../config.js';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

async function prismaPlugin(app: FastifyInstance): Promise<void> {
  const prisma = getPrismaClient({
    datasourceUrl: config.DATABASE_URL,
    logQueries: config.LOG_LEVEL === 'debug' || config.LOG_LEVEL === 'trace',
  });

  await prisma.$connect();
  app.decorate('prisma', prisma);

  app.addHook('onClose', async () => {
    await disconnectPrisma(prisma);
  });
}

export default fp(prismaPlugin, { name: 'prisma' });
