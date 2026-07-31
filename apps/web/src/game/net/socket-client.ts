import type { ClientToServerEvents, MatchTicket, ServerToClientEvents } from '@arena/protocol';
import { io, type Socket } from 'socket.io-client';

export type ArenaSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * Opens the game connection to the realtime node named in the ticket.
 *
 * The URL comes from the matchmaker rather than config: rooms are pinned to a
 * specific node, so connecting to a load-balanced hostname would land the
 * player on a machine that does not host their room.
 */
export function connectToRoom(ticket: MatchTicket): ArenaSocket {
  return io(ticket.realtimeUrl, {
    path: '/ws',
    transports: ['websocket'],
    auth: { ticket: ticket.ticket, roomId: ticket.roomId },
    // Snapshots are packed binary; the JSON parser is bypassed on the hot path.
    forceNew: true,
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 500,
    reconnectionDelayMax: 4_000,
    timeout: 10_000,
    autoConnect: false,
  });
}

/**
 * Estimates clock offset and round-trip time.
 *
 * Interpolation renders at `serverTime - INTERPOLATION_DELAY_MS`, so a wrong
 * offset shows up as permanent stutter rather than a clock bug.
 *
 * TODO: implement — sample repeatedly, discard outliers, keep a running median.
 */
export function createClockSync(_socket: ArenaSocket): {
  offsetMs: () => number;
  rttMs: () => number;
  start: () => void;
  stop: () => void;
} {
  throw new Error('Not implemented');
}
