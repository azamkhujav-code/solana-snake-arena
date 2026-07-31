import type { FoodState, Snapshot } from '@arena/protocol';

/**
 * Snapshot interpolation for remote entities.
 *
 * Snapshots arrive at 15 Hz but the screen refreshes at 60+ Hz. Remote snakes
 * are rendered between the two snapshots straddling
 * `now - INTERPOLATION_DELAY_MS`, which trades a fixed ~100 ms of latency for
 * motion that stays smooth through jitter and a dropped packet.
 *
 * A lower delay looks more responsive right up until the first late packet, at
 * which point every remote snake stutters. 100 ms comfortably covers one missed
 * snapshot at 15 Hz (66 ms).
 */

export interface InterpolatedSnake {
  id: string;
  nickname: string;
  points: Array<{ x: number; y: number }>;
  angle: number;
  radius: number;
  mass: number;
  boosting: boolean;
  isBot: boolean;
}

export interface InterpolatedFrame {
  tick: number;
  serverTime: number;
  snakes: InterpolatedSnake[];
  food: FoodState[];
  /** True when the buffer ran dry and this frame is the newest one held. */
  stale: boolean;
}

export interface SnapshotBuffer {
  /** Ordered by server time, oldest first. */
  snapshots: Snapshot[];
  maxSize: number;
}

export function createSnapshotBuffer(maxSize = 24): SnapshotBuffer {
  return { snapshots: [], maxSize };
}

/**
 * Inserts in server-time order and evicts the oldest.
 *
 * Out-of-order arrival is normal on a lossy connection, so the insert searches
 * backwards rather than assuming append. A duplicate is dropped — re-inserting
 * would create a zero-length interval and divide by zero during sampling.
 */
export function pushSnapshot(buffer: SnapshotBuffer, snapshot: Snapshot): void {
  const { snapshots } = buffer;

  let index = snapshots.length;
  while (index > 0 && snapshots[index - 1]!.serverTime > snapshot.serverTime) index -= 1;

  if (index > 0 && snapshots[index - 1]!.serverTime === snapshot.serverTime) return;

  snapshots.splice(index, 0, snapshot);
  while (snapshots.length > buffer.maxSize) snapshots.shift();
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Interpolates angles the short way round the circle. */
function lerpAngle(a: number, b: number, t: number): number {
  let delta = (b - a) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * t;
}

/**
 * Samples the buffer at `renderTime`.
 *
 * Returns null only when the buffer is empty. If `renderTime` is past the
 * newest snapshot the newest is returned marked `stale` — freezing is better
 * than extrapolating indefinitely, which produces snakes that confidently walk
 * through walls.
 */
export function sampleAt(buffer: SnapshotBuffer, renderTime: number): InterpolatedFrame | null {
  const { snapshots } = buffer;
  if (snapshots.length === 0) return null;

  const newest = snapshots[snapshots.length - 1]!;
  if (snapshots.length === 1 || renderTime >= newest.serverTime) {
    return toFrame(newest, true);
  }

  const oldest = snapshots[0]!;
  if (renderTime <= oldest.serverTime) return toFrame(oldest, false);

  let older = oldest;
  let newer = newest;
  for (let i = 0; i < snapshots.length - 1; i += 1) {
    const a = snapshots[i]!;
    const b = snapshots[i + 1]!;
    if (a.serverTime <= renderTime && renderTime <= b.serverTime) {
      older = a;
      newer = b;
      break;
    }
  }

  const span = newer.serverTime - older.serverTime;
  const t = span <= 0 ? 1 : (renderTime - older.serverTime) / span;

  return blend(older, newer, t);
}

function toFrame(snapshot: Snapshot, stale: boolean): InterpolatedFrame {
  return {
    tick: snapshot.tick,
    serverTime: snapshot.serverTime,
    snakes: snapshot.snakes.map((snake) => ({
      id: snake.id,
      nickname: snake.nickname,
      points: snake.points.map((point) => ({ ...point })),
      angle: snake.angle,
      radius: snake.radius,
      mass: snake.mass,
      boosting: snake.boosting,
      isBot: snake.isBot,
    })),
    food: snapshot.food,
    stale,
  };
}

/**
 * Blends two snapshots.
 *
 * A snake present in only one of the pair is taken verbatim from whichever has
 * it — interpolating against a missing counterpart would slide it in from the
 * origin, which reads as a snake teleporting across the map on spawn.
 */
function blend(older: Snapshot, newer: Snapshot, t: number): InterpolatedFrame {
  const olderById = new Map(older.snakes.map((snake) => [snake.id, snake]));
  const snakes: InterpolatedSnake[] = [];

  for (const target of newer.snakes) {
    const source = olderById.get(target.id);

    if (!source) {
      snakes.push({
        id: target.id,
        nickname: target.nickname,
        points: target.points.map((point) => ({ ...point })),
        angle: target.angle,
        radius: target.radius,
        mass: target.mass,
        boosting: target.boosting,
        isBot: target.isBot,
      });
      continue;
    }

    // The spine grows and shrinks between snapshots; only the overlapping
    // prefix can be blended, and the tail comes from the newer snapshot.
    const shared = Math.min(source.points.length, target.points.length);
    const points: Array<{ x: number; y: number }> = [];

    for (let i = 0; i < shared; i += 1) {
      const a = source.points[i]!;
      const b = target.points[i]!;
      points.push({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });
    }
    for (let i = shared; i < target.points.length; i += 1) {
      points.push({ ...target.points[i]! });
    }

    snakes.push({
      id: target.id,
      nickname: target.nickname,
      points,
      angle: lerpAngle(source.angle, target.angle, t),
      radius: lerp(source.radius, target.radius, t),
      mass: lerp(source.mass, target.mass, t),
      boosting: target.boosting,
      isBot: target.isBot,
    });
  }

  return {
    tick: newer.tick,
    serverTime: lerp(older.serverTime, newer.serverTime, t),
    snakes,
    // Food does not move, so there is nothing to interpolate — blending it
    // would only cost a pass over hundreds of pellets per frame.
    food: newer.food,
    stale: false,
  };
}
