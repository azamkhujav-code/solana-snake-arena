import type { RedisClient } from '@arena/redis';
import { redisKeys } from '@arena/redis';

import type { NodeCandidate } from './strategy.js';

/**
 * Reads the realtime node registry.
 *
 * Nodes publish their own capacity under a TTL that their heartbeat refreshes,
 * so a crashed process disappears without any deregistration step. The set of
 * node ids is the index; the per-node key holds the payload and is what
 * actually expires.
 */

/**
 * Parses one heartbeat payload, tolerating anything malformed.
 *
 * A node running an older build, or a half-written value, must not take
 * placement down for everyone — returning null drops that one candidate and
 * leaves the rest usable. Pure, so the tolerance is testable.
 */
export function parseNodePayload(raw: string | null): NodeCandidate | null {
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Partial<NodeCandidate>;

  // Every field placement actually reads must be present and the right type.
  // A node advertising `players: "many"` would otherwise sort as NaN and win
  // every comparison.
  if (typeof candidate.nodeId !== 'string' || candidate.nodeId.length === 0) return null;
  if (typeof candidate.advertiseUrl !== 'string') return null;
  if (typeof candidate.region !== 'string') return null;
  if (!Number.isFinite(candidate.rooms) || !Number.isFinite(candidate.players)) return null;
  if (!Number.isFinite(candidate.maxRooms) || !Number.isFinite(candidate.saturation)) return null;
  if (!Number.isFinite(candidate.updatedAt)) return null;

  return candidate as NodeCandidate;
}

/**
 * Loads every live node.
 *
 * One MGET rather than a read per node: placement runs on the join path, and a
 * round trip per node would put cluster size directly into join latency.
 * Members whose payload key has expired come back null and are dropped — and
 * cleaned out of the index, so the set does not accumulate dead ids forever.
 */
export async function loadNodes(redis: RedisClient): Promise<NodeCandidate[]> {
  const nodeIds = await redis.smembers(redisKeys.nodeRegistry());
  if (nodeIds.length === 0) return [];

  const payloads = await redis.mget(...nodeIds.map((id) => redisKeys.nodeHeartbeat(id)));

  const nodes: NodeCandidate[] = [];
  const dead: string[] = [];

  for (const [index, payload] of payloads.entries()) {
    const node = parseNodePayload(payload);
    if (node) {
      nodes.push(node);
    } else {
      const id = nodeIds[index];
      if (id !== undefined) dead.push(id);
    }
  }

  // Fire-and-forget: tidying the index is housekeeping, and failing it must not
  // fail the join that triggered it.
  if (dead.length > 0) {
    void redis.srem(redisKeys.nodeRegistry(), ...dead).catch(() => undefined);
  }

  return nodes;
}
