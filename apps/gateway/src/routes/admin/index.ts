import type { FastifyInstance } from 'fastify';

import { adminGameRoutes, adminRoomRoutes } from './games.routes.js';
import { adminLedgerRoutes } from './ledger.routes.js';
import { adminOverviewRoutes } from './overview.routes.js';
import { adminPlayerRoutes } from './players.routes.js';

/**
 * The admin API, mounted at `/v1/admin`.
 *
 * The role guard is applied **once here as a hook on the whole scope**, not
 * per-route. Thirty routes each remembering to list `requireRole('ADMIN')` is
 * thirty chances to forget, and the one that forgets is a public endpoint
 * serving every player's balance. A hook on the encapsulated scope cannot be
 * omitted by a route added later.
 *
 * Read and write are split into two scopes because they warrant different
 * levels of trust: a support agent needs to look things up all day, and giving
 * them the ability to move balances in order to do so is how an internal
 * fraud story starts.
 */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // ---- Read-only: MODERATOR and above -----------------------------------
  await app.register(async (scope) => {
    scope.addHook('onRequest', scope.authenticate);
    scope.addHook('onRequest', scope.requireRole('MODERATOR', 'ADMIN'));

    await scope.register(adminOverviewRoutes);
    await scope.register(adminLedgerRoutes);
  });

  // ---- Mutating: ADMIN only ---------------------------------------------
  //
  // Player and game routes carry both reads and writes. They sit behind the
  // stricter guard rather than being split finer, because a moderator who can
  // read a player record but not the game it came from would just be told to
  // ask an admin — and the answer to that friction is usually to hand out
  // admin, which is worse.
  await app.register(async (scope) => {
    scope.addHook('onRequest', scope.authenticate);
    scope.addHook('onRequest', scope.requireRole('ADMIN'));

    await scope.register(adminPlayerRoutes);
    await scope.register(adminGameRoutes);
    await scope.register(adminRoomRoutes);
  });
}
