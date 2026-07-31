import type { InputBatch, Snapshot } from './schemas.js';

/**
 * Binary snapshot codec.
 *
 * JSON snapshots are the single largest cost at scale: 120 players at 15 Hz of
 * JSON is roughly an order of magnitude more bandwidth and GC pressure than a
 * packed buffer. The hot path therefore serialises to an ArrayBuffer and skips
 * Socket.IO's JSON encoder entirely.
 *
 * Layout is little-endian throughout. Header (22 bytes):
 *
 *   u8   messageType
 *   u8   flags              bit 0 = full snapshot
 *   u16  snakeCount
 *   u16  foodCount
 *   u16  removedSnakeCount
 *   u16  removedFoodCount
 *   u32  tick
 *   u32  serverTime         ms since room start, NOT epoch — an epoch value in
 *                           milliseconds does not fit in u32
 *   u32  ackSeq
 *
 * Positions are quantised to i16 relative to the viewer. At POSITION_SCALE = 4
 * that is 0.25-unit precision over a ±8191 unit window — far finer than a pixel
 * at render scale, and half the bytes of a float32.
 */

export const MessageType = {
  Snapshot: 1,
  InputBatch: 2,
  Ack: 3,
} as const;
export type MessageTypeValue = (typeof MessageType)[keyof typeof MessageType];

export const SnapshotFlags = {
  Full: 1 << 0,
} as const;

export const HEADER_BYTES = 22;

/** Quantisation scale for world coordinates packed as i16. */
export const POSITION_SCALE = 4;

/** Angles are packed into a u16 over the full turn. */
export const ANGLE_SCALE = 65_535 / (Math.PI * 2);

/** Half-width of the representable window around the viewer, in world units. */
export const POSITION_RANGE = 32_767 / POSITION_SCALE;

/** Player ids are UUIDs, so exactly 16 raw bytes on the wire. */
const UUID_BYTES = 16;

export interface EncodeSnapshotOptions {
  /** Viewer position; positions are encoded relative to it. */
  origin: { x: number; y: number };
  full?: boolean;
}

function clampI16(value: number): number {
  return Math.max(-32_768, Math.min(32_767, Math.round(value)));
}

function uuidToBytes(uuid: string, out: Uint8Array, offset: number): void {
  const hex = uuid.replace(/-/g, '');
  for (let i = 0; i < UUID_BYTES; i += 1) {
    out[offset + i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
}

function bytesToUuid(bytes: Uint8Array, offset: number): string {
  let hex = '';
  for (let i = 0; i < UUID_BYTES; i += 1) {
    hex += (bytes[offset + i] ?? 0).toString(16).padStart(2, '0');
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Upper bound on the encoded size, used to size the scratch buffer.
 *
 * Over-estimating costs a little memory once; under-estimating overruns the
 * buffer mid-write, so this errs generously.
 */
function estimateSize(snapshot: Snapshot): number {
  let size = HEADER_BYTES;

  for (const snake of snapshot.snakes) {
    size += UUID_BYTES + 1 + snake.nickname.length * 3 + 2 + 2 + 2 + 1 + 2;
    size += snake.points.length * 4;
  }

  size += snapshot.food.length * 9;
  size += snapshot.removedSnakes.length * UUID_BYTES;
  size += snapshot.removedFood.length * 4;

  return size;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Packs a snapshot for one viewer.
 *
 * Allocates a fresh buffer per call. Pooling belongs at the call site, which
 * knows how many viewers it is about to serialise for — a module-level pool
 * would not be safe once the codec is used from more than one room.
 */
export function encodeSnapshot(snapshot: Snapshot, options: EncodeSnapshotOptions): ArrayBuffer {
  const buffer = new ArrayBuffer(estimateSize(snapshot));
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const { origin } = options;

  view.setUint8(0, MessageType.Snapshot);
  view.setUint8(1, options.full ? SnapshotFlags.Full : 0);
  view.setUint16(2, snapshot.snakes.length, true);
  view.setUint16(4, snapshot.food.length, true);
  view.setUint16(6, snapshot.removedSnakes.length, true);
  view.setUint16(8, snapshot.removedFood.length, true);
  view.setUint32(10, snapshot.tick, true);
  view.setUint32(14, snapshot.serverTime, true);
  view.setUint32(18, snapshot.ackSeq, true);

  let offset = HEADER_BYTES;

  for (const snake of snapshot.snakes) {
    uuidToBytes(snake.id, bytes, offset);
    offset += UUID_BYTES;

    const nickname = encoder.encode(snake.nickname);
    view.setUint8(offset, nickname.length);
    offset += 1;
    bytes.set(nickname, offset);
    offset += nickname.length;

    // Normalise into [0, 2π) before scaling; a negative angle would wrap to a
    // huge u16 and decode to garbage.
    const normalised = ((snake.angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    view.setUint16(offset, Math.round(normalised * ANGLE_SCALE), true);
    offset += 2;

    view.setUint16(offset, Math.min(65_535, Math.round(snake.mass)), true);
    offset += 2;
    view.setUint16(offset, Math.min(65_535, Math.round(snake.radius * 4)), true);
    offset += 2;

    view.setUint8(offset, (snake.boosting ? 1 : 0) | (snake.isBot ? 2 : 0));
    offset += 1;

    view.setUint16(offset, snake.points.length, true);
    offset += 2;

    for (const point of snake.points) {
      view.setInt16(offset, clampI16((point.x - origin.x) * POSITION_SCALE), true);
      view.setInt16(offset + 2, clampI16((point.y - origin.y) * POSITION_SCALE), true);
      offset += 4;
    }
  }

  for (const food of snapshot.food) {
    view.setUint32(offset, food.id, true);
    view.setInt16(offset + 4, clampI16((food.position.x - origin.x) * POSITION_SCALE), true);
    view.setInt16(offset + 6, clampI16((food.position.y - origin.y) * POSITION_SCALE), true);
    view.setUint8(offset + 8, Math.min(255, Math.round(food.mass)));
    offset += 9;
  }

  for (const id of snapshot.removedSnakes) {
    uuidToBytes(id, bytes, offset);
    offset += UUID_BYTES;
  }

  for (const id of snapshot.removedFood) {
    view.setUint32(offset, id, true);
    offset += 4;
  }

  // Trim to what was actually written; the estimate is an upper bound.
  return buffer.slice(0, offset);
}

/** Mirror of {@link encodeSnapshot}, run on the client. */
export function decodeSnapshot(buffer: ArrayBuffer, origin: { x: number; y: number }): Snapshot {
  if (buffer.byteLength < HEADER_BYTES) {
    throw new RangeError('Snapshot buffer is shorter than its header');
  }

  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  const messageType = view.getUint8(0);
  if (messageType !== MessageType.Snapshot) {
    throw new RangeError(`Expected a snapshot message, got type ${messageType}`);
  }

  const snakeCount = view.getUint16(2, true);
  const foodCount = view.getUint16(4, true);
  const removedSnakeCount = view.getUint16(6, true);
  const removedFoodCount = view.getUint16(8, true);

  const snapshot: Snapshot = {
    tick: view.getUint32(10, true),
    serverTime: view.getUint32(14, true),
    ackSeq: view.getUint32(18, true),
    snakes: [],
    food: [],
    removedSnakes: [],
    removedFood: [],
  };

  let offset = HEADER_BYTES;

  for (let i = 0; i < snakeCount; i += 1) {
    const id = bytesToUuid(bytes, offset);
    offset += UUID_BYTES;

    const nicknameLength = view.getUint8(offset);
    offset += 1;
    const nickname = decoder.decode(bytes.subarray(offset, offset + nicknameLength));
    offset += nicknameLength;

    const angle = view.getUint16(offset, true) / ANGLE_SCALE;
    offset += 2;
    const mass = view.getUint16(offset, true);
    offset += 2;
    const radius = view.getUint16(offset, true) / 4;
    offset += 2;

    const flags = view.getUint8(offset);
    offset += 1;

    const pointCount = view.getUint16(offset, true);
    offset += 2;

    const points: { x: number; y: number }[] = [];
    for (let p = 0; p < pointCount; p += 1) {
      points.push({
        x: view.getInt16(offset, true) / POSITION_SCALE + origin.x,
        y: view.getInt16(offset + 2, true) / POSITION_SCALE + origin.y,
      });
      offset += 4;
    }

    snapshot.snakes.push({
      id,
      nickname,
      points,
      angle,
      mass,
      radius,
      boosting: (flags & 1) !== 0,
      isBot: (flags & 2) !== 0,
    });
  }

  for (let i = 0; i < foodCount; i += 1) {
    snapshot.food.push({
      id: view.getUint32(offset, true),
      position: {
        x: view.getInt16(offset + 4, true) / POSITION_SCALE + origin.x,
        y: view.getInt16(offset + 6, true) / POSITION_SCALE + origin.y,
      },
      mass: view.getUint8(offset + 8),
      // Hue is not transmitted; it is derived client-side from the id so the
      // colour is stable without costing two bytes per pellet.
      hue: view.getUint32(offset, true) % 360,
    });
    offset += 9;
  }

  for (let i = 0; i < removedSnakeCount; i += 1) {
    snapshot.removedSnakes.push(bytesToUuid(bytes, offset));
    offset += UUID_BYTES;
  }

  for (let i = 0; i < removedFoodCount; i += 1) {
    snapshot.removedFood.push(view.getUint32(offset, true));
    offset += 4;
  }

  return snapshot;
}

/** Client-side input packing. */
export function encodeInputBatch(batch: InputBatch): ArrayBuffer {
  const buffer = new ArrayBuffer(6 + batch.commands.length * 8);
  const view = new DataView(buffer);

  view.setUint8(0, MessageType.InputBatch);
  view.setUint8(1, batch.commands.length);
  view.setUint32(2, batch.clientTime, true);

  let offset = 6;
  for (const command of batch.commands) {
    view.setUint32(offset, command.seq, true);
    const normalised = ((command.angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    view.setUint16(offset + 4, Math.round(normalised * ANGLE_SCALE), true);
    view.setUint8(offset + 6, command.boost ? 1 : 0);
    view.setUint8(offset + 7, Math.min(255, Math.round(command.dt)));
    offset += 8;
  }

  return buffer;
}

/**
 * Server-side input unpacking.
 *
 * Every length is validated against the buffer before it is used. A malformed
 * packet here is a hostile client, not a bug, so this must reject rather than
 * read past the end.
 */
export function decodeInputBatch(buffer: ArrayBuffer): InputBatch {
  if (buffer.byteLength < 6) throw new RangeError('Input batch is too short');

  const view = new DataView(buffer);
  if (view.getUint8(0) !== MessageType.InputBatch) {
    throw new RangeError('Not an input batch message');
  }

  const count = view.getUint8(1);
  if (count === 0 || count > 10) throw new RangeError(`Invalid input batch size: ${count}`);
  if (buffer.byteLength < 6 + count * 8) {
    throw new RangeError('Input batch is shorter than its declared command count');
  }

  const commands = [];
  let offset = 6;

  for (let i = 0; i < count; i += 1) {
    let angle = view.getUint16(offset + 4, true) / ANGLE_SCALE;
    // The schema expects (-π, π]; the wire format carries [0, 2π).
    if (angle > Math.PI) angle -= Math.PI * 2;

    commands.push({
      seq: view.getUint32(offset, true),
      angle,
      boost: view.getUint8(offset + 6) === 1,
      dt: view.getUint8(offset + 7),
    });
    offset += 8;
  }

  return { commands, clientTime: view.getUint32(2, true) };
}
