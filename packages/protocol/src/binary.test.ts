import { describe, expect, it } from 'vitest';

import {
  decodeInputBatch,
  decodeSnapshot,
  encodeInputBatch,
  encodeSnapshot,
  HEADER_BYTES,
  MessageType,
  POSITION_SCALE,
} from './binary.js';
import type { Snapshot } from './schemas.js';

const origin = { x: 1_000, y: -500 };

const snapshot: Snapshot = {
  tick: 4_242,
  serverTime: 123_456,
  ackSeq: 99,
  snakes: [
    {
      id: '123e4567-e89b-12d3-a456-426614174000',
      nickname: 'alice',
      points: [
        { x: 1_010, y: -490 },
        { x: 1_000, y: -500 },
        { x: 990, y: -510 },
      ],
      angle: 1.25,
      mass: 250,
      radius: 33.5,
      boosting: true,
      isBot: false,
    },
  ],
  food: [
    { id: 7, position: { x: 1_050, y: -450 }, mass: 4, hue: 120 },
    { id: 9, position: { x: 950, y: -550 }, mass: 2, hue: 300 },
  ],
  removedSnakes: ['00000000-0000-0000-0000-0000000000ff'],
  removedFood: [11, 12, 13],
};

describe('snapshot round-trip', () => {
  const buffer = encodeSnapshot(snapshot, { origin });
  const decoded = decodeSnapshot(buffer, origin);

  it('preserves the header fields', () => {
    expect(decoded.tick).toBe(snapshot.tick);
    expect(decoded.serverTime).toBe(snapshot.serverTime);
    expect(decoded.ackSeq).toBe(snapshot.ackSeq);
  });

  it('preserves snake identity and nickname', () => {
    expect(decoded.snakes).toHaveLength(1);
    expect(decoded.snakes[0]?.id).toBe(snapshot.snakes[0]?.id);
    expect(decoded.snakes[0]?.nickname).toBe('alice');
  });

  it('preserves flags', () => {
    expect(decoded.snakes[0]?.boosting).toBe(true);
    expect(decoded.snakes[0]?.isBot).toBe(false);
  });

  it('preserves positions within the quantisation step', () => {
    const step = 1 / POSITION_SCALE;
    snapshot.snakes[0]!.points.forEach((point, index) => {
      const round = decoded.snakes[0]!.points[index]!;
      expect(Math.abs(round.x - point.x)).toBeLessThanOrEqual(step);
      expect(Math.abs(round.y - point.y)).toBeLessThanOrEqual(step);
    });
  });

  it('preserves angle within the quantisation step', () => {
    expect(decoded.snakes[0]!.angle).toBeCloseTo(snapshot.snakes[0]!.angle, 3);
  });

  it('preserves food ids, positions and mass', () => {
    expect(decoded.food.map((f) => f.id)).toEqual([7, 9]);
    expect(decoded.food[0]!.position.x).toBeCloseTo(1_050, 0);
    expect(decoded.food[0]!.mass).toBe(4);
  });

  it('preserves removal lists', () => {
    expect(decoded.removedSnakes).toEqual(snapshot.removedSnakes);
    expect(decoded.removedFood).toEqual([11, 12, 13]);
  });
});

describe('angle handling', () => {
  it('survives a negative angle', () => {
    // The wire carries [0, 2π); a naive cast of a negative angle wraps to a
    // huge u16 and decodes to garbage.
    const negative: Snapshot = {
      ...snapshot,
      snakes: [{ ...snapshot.snakes[0]!, angle: -2.5 }],
      food: [],
      removedSnakes: [],
      removedFood: [],
    };

    const decoded = decodeSnapshot(encodeSnapshot(negative, { origin }), origin);
    // -2.5 rad is the same heading as 2π - 2.5.
    expect(decoded.snakes[0]!.angle).toBeCloseTo(Math.PI * 2 - 2.5, 3);
  });

  it('survives an angle beyond a full turn', () => {
    const wrapped: Snapshot = {
      ...snapshot,
      snakes: [{ ...snapshot.snakes[0]!, angle: Math.PI * 6 + 1 }],
      food: [],
      removedSnakes: [],
      removedFood: [],
    };

    const decoded = decodeSnapshot(encodeSnapshot(wrapped, { origin }), origin);
    expect(decoded.snakes[0]!.angle).toBeCloseTo(1, 3);
  });
});

describe('size', () => {
  it('is dramatically smaller than the JSON equivalent', () => {
    // This is the entire justification for the codec existing.
    const json = Buffer.byteLength(JSON.stringify(snapshot));
    const binary = encodeSnapshot(snapshot, { origin }).byteLength;

    expect(binary).toBeLessThan(json / 2);
  });

  it('emits only a header for an empty snapshot', () => {
    const empty: Snapshot = {
      tick: 1,
      serverTime: 1,
      ackSeq: 0,
      snakes: [],
      food: [],
      removedSnakes: [],
      removedFood: [],
    };

    expect(encodeSnapshot(empty, { origin }).byteLength).toBe(HEADER_BYTES);
  });

  it('trims the buffer to what was written', () => {
    // The size estimate is an upper bound; shipping the slack would waste
    // bandwidth on every packet.
    const buffer = encodeSnapshot(snapshot, { origin });
    expect(buffer.byteLength).toBeLessThan(600);
  });
});

describe('decode validation', () => {
  it('rejects a truncated buffer', () => {
    expect(() => decodeSnapshot(new ArrayBuffer(4), origin)).toThrow(RangeError);
  });

  it('rejects a buffer with the wrong message type', () => {
    const buffer = new ArrayBuffer(HEADER_BYTES);
    new DataView(buffer).setUint8(0, MessageType.InputBatch);

    expect(() => decodeSnapshot(buffer, origin)).toThrow(RangeError);
  });
});

describe('input batch round-trip', () => {
  const batch = {
    clientTime: 987_654,
    commands: [
      { seq: 1, angle: 0.5, boost: false, dt: 33 },
      { seq: 2, angle: -1.5, boost: true, dt: 34 },
      { seq: 3, angle: 3.0, boost: false, dt: 33 },
    ],
  };

  it('preserves every command', () => {
    const decoded = decodeInputBatch(encodeInputBatch(batch));

    expect(decoded.clientTime).toBe(batch.clientTime);
    expect(decoded.commands).toHaveLength(3);
    decoded.commands.forEach((command, index) => {
      expect(command.seq).toBe(batch.commands[index]!.seq);
      expect(command.boost).toBe(batch.commands[index]!.boost);
      expect(command.dt).toBe(batch.commands[index]!.dt);
      expect(command.angle).toBeCloseTo(batch.commands[index]!.angle, 3);
    });
  });

  it('decodes angles back into the schema range', () => {
    const decoded = decodeInputBatch(encodeInputBatch(batch));
    for (const command of decoded.commands) {
      expect(command.angle).toBeGreaterThanOrEqual(-Math.PI);
      expect(command.angle).toBeLessThanOrEqual(Math.PI);
    }
  });

  it('rejects a short buffer', () => {
    expect(() => decodeInputBatch(new ArrayBuffer(2))).toThrow(RangeError);
  });

  it('rejects a lying command count', () => {
    // A hostile client claiming 10 commands in a 1-command buffer must not be
    // able to make the server read past the end.
    const buffer = encodeInputBatch(batch);
    new DataView(buffer).setUint8(1, 10);

    expect(() => decodeInputBatch(buffer)).toThrow(RangeError);
  });

  it('rejects a zero or oversized batch', () => {
    const buffer = encodeInputBatch(batch);
    new DataView(buffer).setUint8(1, 0);
    expect(() => decodeInputBatch(buffer)).toThrow(RangeError);
  });

  it('rejects the wrong message type', () => {
    const buffer = encodeInputBatch(batch);
    new DataView(buffer).setUint8(0, MessageType.Snapshot);
    expect(() => decodeInputBatch(buffer)).toThrow(RangeError);
  });
});
