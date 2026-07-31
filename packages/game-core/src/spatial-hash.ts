import type { EntityId } from './types.js';

/**
 * Packs cell coordinates into one integer key.
 *
 * A string key like `${cx},${cy}` would allocate on every lookup, and the hash
 * is queried thousands of times per tick — that allocation alone is enough to
 * push GC into the frame budget.
 */
export function cellKey(cx: number, cy: number): number {
  // 16-bit signed cell coordinates, biased into unsigned range.
  return ((cx + 32_768) << 16) | (cy + 32_768);
}

/**
 * Uniform-grid spatial hash for collision broad-phase and area-of-interest
 * queries.
 *
 * A naive O(n²) collision check is the first thing that breaks at 120 players
 * per room; bucketing by cell keeps each tick proportional to occupied cells
 * rather than entity pairs.
 */
export class SpatialHash {
  private readonly cellSize: number;
  private readonly buckets = new Map<number, EntityId[]>();

  constructor(cellSize: number) {
    if (cellSize <= 0) throw new RangeError('cellSize must be positive');
    this.cellSize = cellSize;
  }

  private cellOf(value: number): number {
    return Math.floor(value / this.cellSize);
  }

  insert(id: EntityId, x: number, y: number): void {
    const key = cellKey(this.cellOf(x), this.cellOf(y));
    const bucket = this.buckets.get(key);
    if (bucket) bucket.push(id);
    else this.buckets.set(key, [id]);
  }

  remove(id: EntityId, x: number, y: number): void {
    const key = cellKey(this.cellOf(x), this.cellOf(y));
    const bucket = this.buckets.get(key);
    if (!bucket) return;

    const index = bucket.indexOf(id);
    if (index === -1) return;

    // Swap-remove: order within a bucket is irrelevant and this avoids the
    // O(n) shift that splice would cost.
    const last = bucket.pop();
    if (last !== undefined && index < bucket.length) bucket[index] = last;

    if (bucket.length === 0) this.buckets.delete(key);
  }

  /**
   * Ids in every cell overlapping the given circle.
   *
   * Broad-phase only — it returns candidates, and may include entities just
   * outside the radius. The caller does the exact distance check.
   *
   * `out` is reused across calls so a hot loop does not allocate an array per
   * query.
   */
  queryCircle(x: number, y: number, radius: number, out: EntityId[] = []): EntityId[] {
    out.length = 0;

    const minCellX = this.cellOf(x - radius);
    const maxCellX = this.cellOf(x + radius);
    const minCellY = this.cellOf(y - radius);
    const maxCellY = this.cellOf(y + radius);

    for (let cx = minCellX; cx <= maxCellX; cx += 1) {
      for (let cy = minCellY; cy <= maxCellY; cy += 1) {
        const bucket = this.buckets.get(cellKey(cx, cy));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i += 1) out.push(bucket[i]!);
      }
    }

    return out;
  }

  clear(): void {
    this.buckets.clear();
  }

  get cellCount(): number {
    return this.buckets.size;
  }

  get configuredCellSize(): number {
    return this.cellSize;
  }

  /** Total entries across all buckets. Used by tests and metrics. */
  get size(): number {
    let total = 0;
    for (const bucket of this.buckets.values()) total += bucket.length;
    return total;
  }
}
