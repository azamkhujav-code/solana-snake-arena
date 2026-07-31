import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyInstance {
    /** Current on-chain withdrawal fee, in basis points. */
    withdrawalFeeBps: number;
  }
}

/**
 * Caches the on-chain fee configuration.
 *
 * Read once at boot and refreshed periodically rather than fetched per request:
 * a quote endpoint that hits RPC on every keystroke will be rate-limited within
 * minutes. The value only changes when an admin calls `update_config`.
 *
 * TODO: decode the Config account to read the live value. Until the IDL exists,
 * this falls back to the configured default, which is what devnet is
 * initialised with.
 */
async function feesPlugin(app: FastifyInstance): Promise<void> {
  let withdrawalFeeBps = 0;

  Object.defineProperty(app, 'withdrawalFeeBps', {
    get: () => withdrawalFeeBps,
    configurable: true,
  });

  const refresh = async (): Promise<void> => {
    try {
      // TODO: fetch and Borsh-decode the Config PDA.
      withdrawalFeeBps = 0;
    } catch (error) {
      app.log.warn({ err: error }, 'could not refresh on-chain fee config');
    }
  };

  await refresh();

  const timer = setInterval(() => void refresh(), 60_000);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}

export default fp(feesPlugin, { name: 'fees', dependencies: ['solana'] });
