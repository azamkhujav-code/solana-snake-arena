import closeWithGrace from 'close-with-grace';

import { buildApp } from './app.js';
import { config } from './config.js';
import { startReconciler } from './services/reconciler.js';

async function main(): Promise<void> {
  const app = await buildApp();

  /**
   * Recovers deposits and withdrawals that moved on chain but never got
   * confirmed — a closed browser tab, a timed-out RPC, a dropped response.
   *
   * Single-instance convenience. With several gateway replicas this belongs in
   * its own job, or N replicas will all sweep the same rows.
   */
  const reconciler = startReconciler({
    prisma: app.prisma,
    solana: app.solana,
    acquireLock: app.acquireLock,
    withdrawalFeeBps: app.withdrawalFeeBps,
    log: app.log,
  });
  app.addHook('onClose', async () => reconciler.stop());

  /**
   * Graceful shutdown. Kubernetes sends SIGTERM and removes the pod from the
   * Service endpoints concurrently, so the process must keep serving in-flight
   * requests for a beat rather than exiting immediately.
   */
  closeWithGrace({ delay: 15_000 }, async ({ err, signal }) => {
    if (err) {
      app.log.error({ err }, 'shutting down after uncaught error');
    } else {
      app.log.info({ signal }, 'graceful shutdown started');
    }
    await app.close();
  });

  await app.listen({ host: config.HOST, port: config.PORT });
  app.log.info(
    { port: config.PORT, env: config.NODE_ENV, release: config.GIT_SHA },
    'gateway listening',
  );
}

main().catch((error: unknown) => {
  console.error('Fatal error during startup:', error);
  process.exit(1);
});
