import type { Snapshot } from '@arena/protocol';
import { describe, expect, it } from 'vitest';

import {
  createCamera,
  followTarget,
  headingFromScreen,
  isVisible,
  MAX_ZOOM,
  MIN_ZOOM,
  screenToWorld,
  visibleBounds,
  worldToScreen,
  zoomForMass,
} from './camera';
import { createSnapshotBuffer, pushSnapshot, sampleAt } from './net/interpolation';
import {
  createPredictionBuffer,
  pushPrediction,
  reconcile,
  smoothTowards,
  stepPrediction,
} from './net/prediction';

function snapshot(serverTime: number, x: number, angle = 0): Snapshot {
  return {
    tick: serverTime,
    serverTime,
    ackSeq: serverTime,
    snakes: [
      {
        id: '11111111-1111-1111-1111-111111111111',
        nickname: 'a',
        points: [
          { x, y: 0 },
          { x: x - 10, y: 0 },
        ],
        angle,
        mass: 10,
        radius: 12,
        boosting: false,
        isBot: false,
      },
    ],
    food: [],
    removedSnakes: [],
    removedFood: [],
  };
}

describe('snapshot buffer', () => {
  it('keeps snapshots ordered by server time', () => {
    const buffer = createSnapshotBuffer();
    pushSnapshot(buffer, snapshot(300, 0));
    pushSnapshot(buffer, snapshot(100, 0));
    pushSnapshot(buffer, snapshot(200, 0));

    expect(buffer.snapshots.map((s) => s.serverTime)).toEqual([100, 200, 300]);
  });

  it('drops a duplicate rather than creating a zero-length interval', () => {
    // Two snapshots at the same time would divide by zero during sampling.
    const buffer = createSnapshotBuffer();
    pushSnapshot(buffer, snapshot(100, 0));
    pushSnapshot(buffer, snapshot(100, 50));

    expect(buffer.snapshots).toHaveLength(1);
  });

  it('evicts the oldest past the cap', () => {
    const buffer = createSnapshotBuffer(3);
    for (let i = 1; i <= 5; i += 1) pushSnapshot(buffer, snapshot(i * 100, 0));

    expect(buffer.snapshots.map((s) => s.serverTime)).toEqual([300, 400, 500]);
  });
});

describe('interpolation', () => {
  it('returns null when empty', () => {
    expect(sampleAt(createSnapshotBuffer(), 100)).toBeNull();
  });

  it('interpolates halfway between two snapshots', () => {
    const buffer = createSnapshotBuffer();
    pushSnapshot(buffer, snapshot(100, 0));
    pushSnapshot(buffer, snapshot(200, 100));

    const frame = sampleAt(buffer, 150);
    expect(frame?.snakes[0]?.points[0]?.x).toBeCloseTo(50, 5);
    expect(frame?.stale).toBe(false);
  });

  it('lands exactly on a snapshot at its own time', () => {
    const buffer = createSnapshotBuffer();
    pushSnapshot(buffer, snapshot(100, 0));
    pushSnapshot(buffer, snapshot(200, 100));

    expect(sampleAt(buffer, 200)?.snakes[0]?.points[0]?.x).toBeCloseTo(100, 5);
  });

  it('freezes on the newest frame rather than extrapolating', () => {
    // Extrapolating indefinitely produces snakes that walk through walls.
    const buffer = createSnapshotBuffer();
    pushSnapshot(buffer, snapshot(100, 0));
    pushSnapshot(buffer, snapshot(200, 100));

    const frame = sampleAt(buffer, 10_000);
    expect(frame?.stale).toBe(true);
    expect(frame?.snakes[0]?.points[0]?.x).toBeCloseTo(100, 5);
  });

  it('clamps to the oldest frame when asked for a time before the buffer', () => {
    const buffer = createSnapshotBuffer();
    pushSnapshot(buffer, snapshot(100, 0));
    pushSnapshot(buffer, snapshot(200, 100));

    expect(sampleAt(buffer, 0)?.snakes[0]?.points[0]?.x).toBeCloseTo(0, 5);
  });

  it('interpolates angles the short way round', () => {
    const buffer = createSnapshotBuffer();
    pushSnapshot(buffer, snapshot(100, 0, 3.0));
    pushSnapshot(buffer, snapshot(200, 0, -3.0));

    const frame = sampleAt(buffer, 150);
    // Halfway from 3.0 to -3.0 the short way is ~3.14, not ~0.
    expect(Math.abs(frame!.snakes[0]!.angle)).toBeGreaterThan(3);
  });

  it('takes a newly appeared snake verbatim instead of sliding it from the origin', () => {
    const buffer = createSnapshotBuffer();
    const first = snapshot(100, 0);
    const second = snapshot(200, 500);
    second.snakes.push({
      id: '22222222-2222-2222-2222-222222222222',
      nickname: 'b',
      points: [{ x: 900, y: 900 }],
      angle: 0,
      mass: 10,
      radius: 12,
      boosting: false,
      isBot: false,
    });

    pushSnapshot(buffer, first);
    pushSnapshot(buffer, second);

    const spawned = sampleAt(buffer, 150)?.snakes.find((s) => s.nickname === 'b');
    expect(spawned?.points[0]?.x).toBe(900);
  });

  it('handles a spine that grew between snapshots', () => {
    const buffer = createSnapshotBuffer();
    const first = snapshot(100, 0);
    const second = snapshot(200, 100);
    second.snakes[0]!.points.push({ x: 80, y: 0 }, { x: 70, y: 0 });

    pushSnapshot(buffer, first);
    pushSnapshot(buffer, second);

    const frame = sampleAt(buffer, 150);
    expect(frame?.snakes[0]?.points).toHaveLength(4);
  });
});

describe('prediction', () => {
  const dt = 1 / 30;
  const start = { x: 0, y: 0, angle: 0, mass: 50 };

  it('moves the head immediately on input', () => {
    const buffer = createPredictionBuffer(start);
    const state = pushPrediction(buffer, { seq: 1, angle: 0, boost: false, dt: 33 }, dt);

    expect(state.x).toBeGreaterThan(0);
    expect(buffer.pending).toHaveLength(1);
  });

  it('clamps the turn rate exactly as the server does', () => {
    // Diverging here is what produces drift the player sees as jitter.
    const next = stepPrediction(start, { seq: 1, angle: Math.PI, boost: false, dt: 33 }, dt);
    expect(Math.abs(next.angle)).toBeLessThan(Math.PI / 2);
  });

  it('moves further while boosting', () => {
    const plain = stepPrediction(start, { seq: 1, angle: 0, boost: false, dt: 33 }, dt);
    const boosted = stepPrediction(start, { seq: 1, angle: 0, boost: true, dt: 33 }, dt);

    expect(boosted.x).toBeGreaterThan(plain.x);
  });

  it('refuses to boost below the minimum mass', () => {
    const light = { ...start, mass: 5 };
    const plain = stepPrediction(light, { seq: 1, angle: 0, boost: false, dt: 33 }, dt);
    const boosted = stepPrediction(light, { seq: 1, angle: 0, boost: true, dt: 33 }, dt);

    expect(boosted.x).toBeCloseTo(plain.x, 6);
  });

  it('drops acknowledged inputs', () => {
    const buffer = createPredictionBuffer(start);
    for (let seq = 1; seq <= 5; seq += 1) {
      pushPrediction(buffer, { seq, angle: 0, boost: false, dt: 33 }, dt);
    }

    reconcile(buffer, { ...buffer.state }, 3, dt);
    expect(buffer.pending.map((c) => c.seq)).toEqual([4, 5]);
  });

  it('ignores a sub-threshold error rather than jittering', () => {
    // Correcting a sub-pixel discrepancy every snapshot is visible and useless.
    const buffer = createPredictionBuffer(start);
    pushPrediction(buffer, { seq: 1, angle: 0, boost: false, dt: 33 }, dt);
    const predicted = { ...buffer.state };

    const result = reconcile(buffer, { ...predicted, x: predicted.x + 1 }, 1, dt);

    expect(result.corrected).toBe(false);
    expect(buffer.state.x).toBe(predicted.x);
  });

  it('snaps and replays when the error is large', () => {
    const buffer = createPredictionBuffer(start);
    for (let seq = 1; seq <= 4; seq += 1) {
      pushPrediction(buffer, { seq, angle: 0, boost: false, dt: 33 }, dt);
    }

    const result = reconcile(buffer, { x: 500, y: 0, angle: 0, mass: 50 }, 2, dt);

    expect(result.corrected).toBe(true);
    expect(result.replayed).toBe(2);
    // Replayed forward from the authoritative position, not left at it.
    expect(buffer.state.x).toBeGreaterThan(500);
  });

  it('always takes mass from the server', () => {
    // The client cannot know what it ate.
    const buffer = createPredictionBuffer(start);
    pushPrediction(buffer, { seq: 1, angle: 0, boost: false, dt: 33 }, dt);

    reconcile(buffer, { ...buffer.state, mass: 999 }, 1, dt);
    expect(buffer.state.mass).toBe(999);
  });

  it('bounds the pending queue when the server stops acknowledging', () => {
    const buffer = createPredictionBuffer(start);
    buffer.maxPending = 10;
    for (let seq = 1; seq <= 50; seq += 1) {
      pushPrediction(buffer, { seq, angle: 0, boost: false, dt: 33 }, dt);
    }

    expect(buffer.pending.length).toBeLessThanOrEqual(10);
  });
});

describe('smoothTowards', () => {
  it('moves partway toward the target', () => {
    expect(smoothTowards({ x: 0, y: 0 }, { x: 100, y: 0 }, 0.5)).toEqual({ x: 50, y: 0 });
  });

  it('clamps the factor', () => {
    expect(smoothTowards({ x: 0, y: 0 }, { x: 100, y: 0 }, 5)).toEqual({ x: 100, y: 0 });
    expect(smoothTowards({ x: 0, y: 0 }, { x: 100, y: 0 }, -1)).toEqual({ x: 0, y: 0 });
  });
});

describe('camera', () => {
  it('zooms out as mass grows', () => {
    expect(zoomForMass(1_000)).toBeLessThan(zoomForMass(10));
  });

  it('stays within the zoom limits', () => {
    expect(zoomForMass(0)).toBeLessThanOrEqual(MAX_ZOOM);
    expect(zoomForMass(1_000_000)).toBeGreaterThanOrEqual(MIN_ZOOM);
  });

  it('eases toward the target instead of snapping', () => {
    const camera = createCamera(800, 600);
    followTarget(camera, { x: 1_000, y: 0 }, 1, 16);

    expect(camera.x).toBeGreaterThan(0);
    expect(camera.x).toBeLessThan(1_000);
  });

  it('follows at the same rate regardless of frame rate', () => {
    // A raw per-frame lerp makes the camera lag more on a slow device, which
    // is a gameplay difference caused purely by hardware.
    const fast = createCamera(800, 600);
    for (let i = 0; i < 10; i += 1) followTarget(fast, { x: 1_000, y: 0 }, 1, 10);

    const slow = createCamera(800, 600);
    for (let i = 0; i < 2; i += 1) followTarget(slow, { x: 1_000, y: 0 }, 1, 50);

    expect(Math.abs(fast.x - slow.x)).toBeLessThan(20);
  });

  it('round-trips world and screen coordinates', () => {
    const camera = createCamera(800, 600);
    camera.x = 500;
    camera.y = -200;
    camera.zoom = 0.8;

    const screen = worldToScreen(camera, 640, -120);
    const world = screenToWorld(camera, screen.x, screen.y);

    expect(world.x).toBeCloseTo(640, 6);
    expect(world.y).toBeCloseTo(-120, 6);
  });

  it('puts the camera centre at the middle of the viewport', () => {
    const camera = createCamera(800, 600);
    camera.x = 123;
    camera.y = 456;

    expect(worldToScreen(camera, 123, 456)).toEqual({ x: 400, y: 300 });
  });

  it('derives heading from the viewport centre', () => {
    // The snake is always centred, so this stays correct at any zoom.
    const camera = createCamera(800, 600);
    expect(headingFromScreen(camera, 800, 300)).toBeCloseTo(0, 5);
    expect(headingFromScreen(camera, 400, 600)).toBeCloseTo(Math.PI / 2, 5);
  });

  it('culls entities outside the viewport', () => {
    const camera = createCamera(800, 600);
    const bounds = visibleBounds(camera);

    expect(isVisible(bounds, 0, 0)).toBe(true);
    expect(isVisible(bounds, 100_000, 0)).toBe(false);
  });

  it('pads the bounds so partly visible entities are not culled', () => {
    const camera = createCamera(800, 600);
    const bounds = visibleBounds(camera, 200);

    // Just off the right edge, but its radius reaches on screen.
    expect(isVisible(bounds, 420, 0, 50)).toBe(true);
  });

  it('widens the visible area as it zooms out', () => {
    const camera = createCamera(800, 600);
    const near = visibleBounds(camera);
    camera.zoom = 0.5;
    const far = visibleBounds(camera);

    expect(far.maxX - far.minX).toBeGreaterThan(near.maxX - near.minX);
  });
});
