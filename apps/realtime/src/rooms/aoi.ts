import type { EntityId } from '@arena/game-core';

/**
 * Area-of-interest filtering.
 *
 * Without it, every player receives every entity and per-room bandwidth grows
 * as O(players²) — the single biggest reason a naive .io server falls over
 * somewhere around 40 concurrent players in one world. With it, each client
 * receives a roughly constant number of entities regardless of room size.
 */

export interface AoiView {
  /** Entities currently visible to this viewer. */
  visible: Set<EntityId>;
  /** Entities that became visible since the last snapshot. */
  entered: EntityId[];
  /** Entities that left the view and must be despawned client-side. */
  exited: EntityId[];
}

export function createAoiView(): AoiView {
  return { visible: new Set(), entered: [], exited: [] };
}

/**
 * Diffs the current candidate set against what the viewer already has.
 *
 * The view object is mutated in place and its arrays are reused across ticks.
 * Allocating two arrays and a Set per player per snapshot is enough garbage to
 * show up as GC pauses at 120 players — and a GC pause is a missed tick.
 */
export function updateAoiView(view: AoiView, candidates: readonly EntityId[]): AoiView {
  view.entered.length = 0;
  view.exited.length = 0;

  // Anything in the candidate set that the viewer did not have is new.
  for (const id of candidates) {
    if (!view.visible.has(id)) view.entered.push(id);
  }

  const candidateSet = new Set(candidates);
  for (const id of view.visible) {
    if (!candidateSet.has(id)) view.exited.push(id);
  }

  view.visible = candidateSet;
  return view;
}

/** Squared distance test, avoiding a square root in the hot path. */
export function withinRadius(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  radius: number,
): boolean {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy <= radius * radius;
}
