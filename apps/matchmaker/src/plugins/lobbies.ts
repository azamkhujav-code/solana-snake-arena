import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { randomUUID } from 'node:crypto';

import { LobbyService, type LaunchRequest } from '@arena/lobby';
import { RedisLobbyStore } from '@arena/lobby';
import { filterHealthy, selectPlacement, type NodeCandidate } from '../placement/strategy.js';
import { buildTicketClaims, mintTicket } from '../placement/ticket.js';
import { config } from '../config.js';

declare module 'fastify' {
  interface FastifyInstance {
    lobbies: LobbyService;
  }
}

/**
 * Wires the lobby service to Redis and starts the countdown ticker.
 *
 * The ticker is what turns an expired countdown into a launch. Countdown
 * expiry cannot be event-driven — nothing happens at the moment a timer runs
 * out, so something has to look.
 */
async function lobbiesPlugin(app: FastifyInstance): Promise<void> {
  const store = new RedisLobbyStore(app.redis);

  /**
   * Turns a full lobby into a real game.
   *
   * TODO: create the on-chain room and escrow entry fees for paid tiers, and
   * persist the Game/GamePlayer rows. Both need the gateway (which owns Prisma
   * and the settlement key), so this will call it over the internal API rather
   * than reaching into the database from here.
   */
  const launch = async (request: LaunchRequest): Promise<string> => {
    const candidates = await readNodeRegistry(app);
    const healthy = filterHealthy(candidates, config.NODE_HEARTBEAT_TTL_SECONDS * 1_000);

    const placement = selectPlacement(
      healthy,
      { mode: 'wager', region: 'us-east', playerId: request.players[0]?.playerId ?? '' },
      config.PLACEMENT_STRATEGY,
    );

    if (!placement) {
      // Surfaces as a launch failure, which resets the lobby rather than
      // leaving it wedged in `launching`.
      throw new Error(`No healthy realtime node available for tier ${request.tierId}`);
    }

    /**
     * The prepared game, not a fresh one.
     *
     * The worker creates a game row and its on-chain vault before the lobby
     * opens, and the lobby carries that id. Minting a new one here severed the
     * match from its own escrow: fees would be paid into one game's vault while
     * the match ran under another id, and settlement — which looks the game up
     * by id — found nothing to settle.
     *
     * Falling back to a random id keeps unprepared tiers (free rooms, which
     * have no vault) working exactly as before.
     */
    const gameId = request.gameId ?? randomUUID();
    const roomId = gameId.replace(/-/g, '').slice(0, 16);

    for (const player of request.players) {
      const ticket = mintTicket(
        buildTicketClaims({
          playerId: player.playerId,
          wallet: player.wallet,
          roomId,
          nodeId: placement.nodeId,
          nickname: player.nickname,
          // Binds the room to the game its escrow was funded under, so the node
          // can report standings settlement can actually match to a vault.
          gameId,
        }),
        config.JWT_SECRET,
      );

      // Tickets are registered so a realtime node can consume each exactly
      // once; the signature alone would allow unlimited sockets.
      await app.redis.set(`ticket:${player.playerId}`, ticket, 'EX', 60);
      await app.redis.set(
        `ticket:meta:${player.playerId}`,
        JSON.stringify({ roomId, gameId, realtimeUrl: placement.advertiseUrl }),
        'EX',
        60,
      );
    }

    app.log.info(
      { tierId: request.tierId, gameId, nodeId: placement.nodeId, players: request.players.length },
      'lobby launched',
    );

    return gameId;
  };

  const lobbies = new LobbyService({
    store,
    launch,
    onError: (error, context) => app.log.error({ err: error, ...context }, 'lobby error'),
  });

  app.decorate('lobbies', lobbies);

  let ticking = false;
  const timer = setInterval(() => {
    if (ticking) return; // never overlap passes
    ticking = true;
    void lobbies
      .tickAll()
      .catch((error: unknown) => app.log.error({ err: error }, 'lobby tick failed'))
      .finally(() => {
        ticking = false;
      });
  }, 1_000);

  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}

/** Reads the realtime node registry that each node heartbeats into. */
async function readNodeRegistry(app: FastifyInstance): Promise<NodeCandidate[]> {
  const nodeIds = await app.redis.smembers('cluster:nodes');
  if (nodeIds.length === 0) return [];

  const entries = await Promise.all(
    nodeIds.map(async (nodeId) => {
      const raw = await app.redis.get(`cluster:node:${nodeId}`);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as NodeCandidate;
      } catch {
        return null;
      }
    }),
  );

  return entries.filter((entry): entry is NodeCandidate => entry !== null);
}

export default fp(lobbiesPlugin, { name: 'lobbies' });
