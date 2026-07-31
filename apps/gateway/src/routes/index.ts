import type { FastifyInstance } from 'fastify';

import { adminRoutes } from './admin/index.js';
import { authRoutes } from './auth.routes.js';
import { fundsRoutes } from './funds.routes.js';
import { healthRoutes } from './health.js';
import { leaderboardRoutes } from './leaderboard.routes.js';
import { matchWalletRoutes } from './match-wallet.routes.js';
import { matchRoutes } from './matches.routes.js';
import { playerRoutes } from './players.routes.js';
import { rewardRoutes } from './rewards.routes.js';
import { gameRoutes, roomRoutes } from './rooms.routes.js';
import { stakeRoutes } from './stake.routes.js';
import { walletRoutes } from './wallet.routes.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(healthRoutes);

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(playerRoutes);
      await api.register(leaderboardRoutes);
      await api.register(matchRoutes);
      await api.register(matchWalletRoutes);
      await api.register(walletRoutes);
      await api.register(stakeRoutes);
      await api.register(fundsRoutes);
      await api.register(roomRoutes);
      await api.register(gameRoutes);
      await api.register(rewardRoutes);
      // Scoped guard lives inside adminRoutes; see the note there.
      await api.register(adminRoutes, { prefix: '/admin' });
    },
    { prefix: '/v1' },
  );
}
