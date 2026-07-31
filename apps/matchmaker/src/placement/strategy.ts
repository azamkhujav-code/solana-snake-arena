import type { GameMode, Region } from '@arena/protocol';

export interface NodeCandidate {
  nodeId: string;
  advertiseUrl: string;
  region: Region;
  rooms: number;
  players: number;
  maxRooms: number;
  /** 0..1, derived from tick headroom rather than raw player count. */
  saturation: number;
  /** Epoch ms of the last heartbeat. */
  updatedAt: number;
  draining?: boolean;
}

export interface PlacementRequest {
  mode: GameMode;
  region: Region;
  playerId: string;
}

export interface PlacementDecision {
  nodeId: string;
  advertiseUrl: string;
}

export type PlacementStrategy = 'least-loaded' | 'best-fit' | 'region-affinity';

/**
 * Drops nodes that are draining, at capacity, or whose heartbeat has gone
 * stale.
 *
 * The staleness check is what makes a crashed node stop receiving players
 * without any explicit deregistration: its heartbeat key simply stops being
 * refreshed.
 */
export function filterHealthy(
  candidates: readonly NodeCandidate[],
  maxAgeMs: number,
  now: number = Date.now(),
): NodeCandidate[] {
  return candidates.filter(
    (node) => !node.draining && node.rooms < node.maxRooms && now - node.updatedAt <= maxAgeMs,
  );
}

/**
 * Chooses which node a new room is created on.
 *
 * Default is best-fit, not least-loaded. Least-loaded spreads rooms evenly,
 * which sounds fair but leaves every node partly loaded, so none can ever be
 * scaled down. Best-fit packs onto the most-loaded node that still has
 * headroom, keeping the tail of the fleet empty and reclaimable.
 *
 * "Headroom" is measured by saturation (tick duration against budget), not by
 * player count: a node can be well under its player cap and still be missing
 * frames because one room got dense.
 */
export function selectPlacement(
  candidates: readonly NodeCandidate[],
  request: PlacementRequest,
  strategy: PlacementStrategy = 'best-fit',
): PlacementDecision | null {
  if (candidates.length === 0) return null;

  const inRegion = candidates.filter((node) => node.region === request.region);

  // Region affinity is a hard requirement for its own strategy and a
  // preference for the others — cross-region play is worse than a thin lobby,
  // but an empty region is worse than either.
  const pool =
    strategy === 'region-affinity' ? inRegion : inRegion.length > 0 ? inRegion : [...candidates];

  if (pool.length === 0) return null;

  // Never place onto a node that is already at or beyond its saturation budget.
  const usable = pool.filter((node) => node.saturation < 0.85);
  const finalPool = usable.length > 0 ? usable : pool;

  const sorted = [...finalPool].sort((a, b) => {
    if (strategy === 'least-loaded') return a.saturation - b.saturation;
    // best-fit / region-affinity: most loaded first, so empty nodes stay empty.
    return b.saturation - a.saturation;
  });

  const chosen = sorted[0];
  if (!chosen) return null;

  return { nodeId: chosen.nodeId, advertiseUrl: chosen.advertiseUrl };
}
