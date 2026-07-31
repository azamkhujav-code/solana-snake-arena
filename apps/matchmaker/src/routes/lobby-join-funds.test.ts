import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JoinResult } from '@arena/lobby';

import { lobbyRoutes } from './lobby.routes.js';

/**
 * Joining a paid room must not take any money.
 *
 * The fee is collected from every entrant's own wallet just before the match
 * starts, once the room has actually reached its minimum. Joining only checks
 * that the wallet *could* pay.
 *
 * That ordering is the whole point. Charging at join created an obligation to
 * give the money back when the seat fell through — and the release lived in a
 * `catch` that the common case never reached, because `LobbyService.join`
 * answers a closed or launching lobby by *returning*
 * `{ ok: false, rejected: 'lobby-launching' }` rather than throwing. The fee
 * stayed held against a lobby the player had been refused from. Taking payment
 * later deletes that entire class of bug rather than fixing one instance of it.
 *
 * These mock the funds client rather than the gateway, because the assertion is
 * about *what the join path calls*, and a real HTTP round trip would only add a
 * way for the test to fail for unrelated reasons.
 */

const canAfford = vi.fn();
const releaseStake = vi.fn();

vi.mock('../services/stake-client.js', () => ({
  canAfford: (...args: unknown[]) => canAfford(...args),
  releaseStake: (...args: unknown[]) => releaseStake(...args),
  StakeError: class StakeError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

/** A paid tier, so the stake path is exercised at all. */
const PAID_TIER = 'gold';

function buildApp(joinResult: JoinResult): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  return (async () => {
    await app.register(sensible);

    await app.register(
      fp(async (instance) => {
        instance.decorate('authenticate', async () => undefined);

        // Stubs stand in for the auth plugin and the lobby service. The casts
        // are confined to these two lines: only the fields this route reads are
        // provided, and widening them to the real types would mean building a
        // Redis-backed LobbyService to assert a branch that never reaches it.
        instance.decorateRequest('user', null as never);
        instance.addHook('onRequest', async (request) => {
          (request as unknown as { user: unknown }).user = {
            sub: '11111111-1111-4111-8111-111111111111',
            wallet: 'So11111111111111111111111111111111111111112',
          };
        });

        instance.decorate('lobbies', {
          join: async () => joinResult,
        } as never);
      }),
    );

    await app.register(lobbyRoutes, { prefix: '/v1' });
    await app.ready();
    return app;
  })();
}

async function join(app: FastifyInstance) {
  return app.inject({
    method: 'POST',
    url: '/v1/lobbies/join',
    payload: { tierId: PAID_TIER, nickname: 'alice' },
    headers: { authorization: 'Bearer token' },
  });
}

describe('entry fee when joining', () => {
  beforeEach(() => {
    canAfford.mockReset().mockResolvedValue({
      tierId: PAID_TIER,
      requiredLamports: '100000000',
      walletLamports: '2000000000',
      sufficient: true,
    });
    releaseStake.mockReset().mockResolvedValue({ releasedLamports: '0' });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('checks the wallet but takes nothing', async () => {
    const app = await buildApp({ ok: true, rejected: null, lobby: null });

    const response = await join(app);

    expect(response.statusCode).toBe(200);
    expect(canAfford).toHaveBeenCalledWith(PAID_TIER, 'token');
    // Nothing was taken, so nothing can be stranded.
    expect(releaseStake).not.toHaveBeenCalled();

    await app.close();
  });

  it('takes nothing when the lobby refuses the seat', async () => {
    // The case the old refund path could not see: a rejection is returned, not
    // thrown. With no charge at join there is nothing to hand back.
    const app = await buildApp({ ok: false, rejected: 'lobby-launching', lobby: null });

    const response = await join(app);

    expect(response.statusCode).toBe(200);
    expect(releaseStake).not.toHaveBeenCalled();

    await app.close();
  });

  it('refuses a player whose wallet cannot cover the fee', async () => {
    // A seat held by somebody who cannot pay is a seat nobody else can use, and
    // a room that reaches its minimum and then fails to collect is worse than
    // one that never filled.
    canAfford.mockResolvedValue({
      tierId: PAID_TIER,
      requiredLamports: '100000000',
      walletLamports: '1000',
      sufficient: false,
    });

    const app = await buildApp({ ok: true, rejected: null, lobby: null });

    const response = await join(app);

    expect(response.statusCode).toBe(409);
    await app.close();
  });
});
