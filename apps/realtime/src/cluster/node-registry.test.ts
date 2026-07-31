import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { config } from '../config.js';
import { NodeRegistry } from './node-registry.js';

/**
 * Node registration and its heartbeat.
 *
 * The matchmaker starts every placement from the `cluster:nodes` set, so a node
 * missing from it is invisible no matter how healthy it actually is — the
 * symptom is a blanket "no realtime capacity available" with the node sitting
 * there logging that it registered fine.
 */

/** Redis stand-in recording set membership and key writes. */
function createRedisStub() {
  const members = new Set<string>();
  const keys = new Map<string, string>();

  return {
    members,
    keys,
    sadd: vi.fn((_key: string, member: string) => {
      members.add(member);
      return Promise.resolve(1);
    }),
    srem: vi.fn((_key: string, member: string) => {
      members.delete(member);
      return Promise.resolve(1);
    }),
    set: vi.fn((key: string, value: string) => {
      keys.set(key, value);
      return Promise.resolve('OK');
    }),
    del: vi.fn(() => Promise.resolve(1)),
  };
}

const rooms = { roomCount: 0, playerCount: 0, saturation: () => 0 };
const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };

function createRegistry() {
  const redis = createRedisStub();
  return { redis, registry: new NodeRegistry(redis as never, rooms as never, log as never) };
}

describe('NodeRegistry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('adds the node to the registry set on register', async () => {
    const { redis, registry } = createRegistry();
    await registry.register();

    expect(redis.members.has(config.NODE_ID)).toBe(true);
    expect(redis.keys.has(`cluster:node:${config.NODE_ID}`)).toBe(true);
  });

  it('re-adds itself to the set on every heartbeat', async () => {
    // The regression that took the deployed game down: a rolling deploy runs
    // two instances under one node id, so the outgoing one's `deregister`
    // removed the id the incoming one had just added. The heartbeat kept
    // refreshing the detail key, but placement reads the set — so the node was
    // invisible and every /matchmake returned 503 until it was restarted.
    const { redis, registry } = createRegistry();
    await registry.register();

    // The predecessor shutting down, after the new instance registered.
    await redis.srem('cluster:nodes', config.NODE_ID);
    expect(redis.members.has(config.NODE_ID)).toBe(false);

    registry.startHeartbeat();
    await vi.advanceTimersByTimeAsync(config.NODE_HEARTBEAT_TTL_SECONDS * 1_000);
    registry.stopHeartbeat();

    expect(redis.members.has(config.NODE_ID)).toBe(true);
  });

  it('keeps refreshing the detail key', async () => {
    const { redis, registry } = createRegistry();
    await registry.register();
    redis.set.mockClear();

    registry.startHeartbeat();
    await vi.advanceTimersByTimeAsync(config.NODE_HEARTBEAT_TTL_SECONDS * 1_000);
    registry.stopHeartbeat();

    expect(redis.set).toHaveBeenCalled();
  });
});
