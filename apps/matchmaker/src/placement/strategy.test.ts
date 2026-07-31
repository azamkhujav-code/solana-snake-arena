import { describe, expect, it } from 'vitest';

import { filterHealthy, selectPlacement, type NodeCandidate } from './strategy.js';

const NOW = 1_700_000_000_000;

function node(overrides: Partial<NodeCandidate> = {}): NodeCandidate {
  return {
    nodeId: 'node-1',
    advertiseUrl: 'http://node-1:4001',
    region: 'us-east',
    rooms: 5,
    players: 200,
    maxRooms: 40,
    saturation: 0.4,
    updatedAt: NOW,
    ...overrides,
  };
}

const request = { mode: 'wager' as const, region: 'us-east' as const, playerId: 'p1' };

describe('filterHealthy', () => {
  it('keeps a healthy node', () => {
    expect(filterHealthy([node()], 15_000, NOW)).toHaveLength(1);
  });

  it('drops a node whose heartbeat went stale', () => {
    // This is what makes a crashed node stop receiving players without any
    // explicit deregistration.
    expect(filterHealthy([node({ updatedAt: NOW - 20_000 })], 15_000, NOW)).toHaveLength(0);
  });

  it('drops a draining node', () => {
    expect(filterHealthy([node({ draining: true })], 15_000, NOW)).toHaveLength(0);
  });

  it('drops a node at its room cap', () => {
    expect(filterHealthy([node({ rooms: 40, maxRooms: 40 })], 15_000, NOW)).toHaveLength(0);
  });
});

describe('selectPlacement', () => {
  it('returns null with no candidates', () => {
    expect(selectPlacement([], request)).toBeNull();
  });

  it('best-fit packs onto the most loaded node with headroom', () => {
    // Keeps the tail of the fleet empty and therefore reclaimable.
    const chosen = selectPlacement(
      [
        node({ nodeId: 'empty', saturation: 0.05 }),
        node({ nodeId: 'busy', saturation: 0.7 }),
        node({ nodeId: 'middling', saturation: 0.4 }),
      ],
      request,
      'best-fit',
    );

    expect(chosen?.nodeId).toBe('busy');
  });

  it('least-loaded spreads instead', () => {
    const chosen = selectPlacement(
      [node({ nodeId: 'empty', saturation: 0.05 }), node({ nodeId: 'busy', saturation: 0.7 })],
      request,
      'least-loaded',
    );

    expect(chosen?.nodeId).toBe('empty');
  });

  it('never packs onto a node past its saturation budget', () => {
    // A node at 0.9 is already missing frames; adding a room makes it worse.
    const chosen = selectPlacement(
      [node({ nodeId: 'overloaded', saturation: 0.95 }), node({ nodeId: 'ok', saturation: 0.5 })],
      request,
      'best-fit',
    );

    expect(chosen?.nodeId).toBe('ok');
  });

  it('falls back to an overloaded node only when nothing else exists', () => {
    // A degraded game beats no game at all.
    const chosen = selectPlacement([node({ nodeId: 'only', saturation: 0.99 })], request);
    expect(chosen?.nodeId).toBe('only');
  });

  it('prefers the requested region', () => {
    const chosen = selectPlacement(
      [
        node({ nodeId: 'eu', region: 'eu-west', saturation: 0.8 }),
        node({ nodeId: 'us', region: 'us-east', saturation: 0.2 }),
      ],
      request,
      'best-fit',
    );

    // Even though 'eu' is a better best-fit, region wins — cross-region latency
    // is worse than a slightly emptier node.
    expect(chosen?.nodeId).toBe('us');
  });

  it('crosses regions when the requested one is empty', () => {
    const chosen = selectPlacement(
      [node({ nodeId: 'eu', region: 'eu-west' })],
      request,
      'best-fit',
    );
    expect(chosen?.nodeId).toBe('eu');
  });

  it('region-affinity refuses to cross regions', () => {
    const chosen = selectPlacement(
      [node({ nodeId: 'eu', region: 'eu-west' })],
      request,
      'region-affinity',
    );
    expect(chosen).toBeNull();
  });
});
