import { waitForRedis } from '@arena/redis';
import closeWithGrace from 'close-with-grace';

import { config } from './config.js';
import { drainNode } from './cluster/drain.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const { app, io, rooms, registryClient } = await buildServer();

  await app.listen({ host: config.HOST, port: config.PORT });

  // Registration is the first Redis command this process issues, and it runs
  // milliseconds after boot. `enableOfflineQueue` is false by design, so
  // without this the command races the connection and throws
  // `Stream isn't writeable` — a crash-loop that reads as a Redis outage.
  await waitForRedis(registryClient.redis);

  await registryClient.register();
  registryClient.startHeartbeat();
  rooms.startLoop();

  app.log.info(
    {
      port: config.PORT,
      nodeId: config.NODE_ID,
      tickRate: config.TICK_RATE_HZ,
      snapshotRate: config.SNAPSHOT_RATE_HZ,
      maxRooms: config.MAX_ROOMS_PER_NODE,
    },
    'realtime node listening',
  );

  closeWithGrace({ delay: (config.DRAIN_TIMEOUT_SECONDS + 10) * 1000 }, async ({ err, signal }) => {
    if (err) {
      app.log.error({ err }, 'shutting down after uncaught error');
    } else {
      app.log.info({ signal }, 'drain started');
    }

    process.env.ARENA_DRAINING = 'true';
    registryClient.stopHeartbeat();
    await registryClient.deregister();

    await drainNode({
      io,
      rooms,
      registry: registryClient,
      log: app.log,
      timeoutSeconds: config.DRAIN_TIMEOUT_SECONDS,
    });

    rooms.stopLoop();
    await io.close();
    await app.close();
  });
}

main().catch((error: unknown) => {
  console.error('Fatal error during startup:', error);
  process.exit(1);
});
