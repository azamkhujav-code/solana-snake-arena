import closeWithGrace from 'close-with-grace';

import { buildApp } from './app.js';
import { config } from './config.js';

async function main(): Promise<void> {
  const app = await buildApp();

  closeWithGrace({ delay: 10_000 }, async ({ err, signal }) => {
    if (err) app.log.error({ err }, 'shutting down after uncaught error');
    else app.log.info({ signal }, 'graceful shutdown started');
    await app.close();
  });

  await app.listen({ host: config.HOST, port: config.PORT });
  app.log.info({ port: config.PORT, strategy: config.PLACEMENT_STRATEGY }, 'matchmaker listening');
}

main().catch((error: unknown) => {
  console.error('Fatal error during startup:', error);
  process.exit(1);
});
