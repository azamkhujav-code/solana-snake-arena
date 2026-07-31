import type { Logger } from '@arena/logger';
import {
  ClientEvent,
  inputBatchSchema,
  isProtocolCompatible,
  PROTOCOL_VERSION,
  ServerEvent,
} from '@arena/protocol';

import { chatPayloadSchema, EventGuard, sanitiseChat } from '../../anticheat/event-guard.js';
import { decaySuspicion, shouldShadowban, validateInputBatch } from '../../anticheat/validators.js';
import { config, TICK_INTERVAL_MS } from '../../config.js';
import { droppedInputs, socketEvents } from '../../metrics.js';
import type { RoomManager } from '../../rooms/room-manager.js';
import { getGuard, releaseGuard } from '../middleware/rate-limit.js';
import type { ArenaServer } from '../socket-server.js';

/**
 * Wires per-connection handlers.
 *
 * On connect the socket is placed into its ticketed room. On disconnect the
 * snake is *not* removed — a reconnect grace window runs first, so a brief
 * network blip does not cost the player their run.
 */
export function registerConnectionHandlers(io: ArenaServer, rooms: RoomManager, log: Logger): void {
  io.on('connection', (socket) => {
    const { playerId, roomId, gameId, nickname } = socket.data;
    socketEvents.inc({ event: 'connect' });

    if (!playerId || !roomId) {
      socket.emit(ServerEvent.Error, {
        code: 'UNAUTHORIZED',
        message: 'Socket is missing session data',
        retryable: false,
      });
      socket.disconnect(true);
      return;
    }

    let room;
    try {
      room = rooms.ensureRoom(roomId, 'casual', 'us-east', gameId ?? null);
    } catch (error) {
      log.error({ err: error, roomId }, 'could not allocate room');
      socket.emit(ServerEvent.Error, {
        code: 'SERVER_DRAINING',
        message: 'This node cannot host more rooms',
        retryable: true,
      });
      socket.disconnect(true);
      return;
    }

    if (room.status === 'draining' || room.status === 'closed') {
      socket.emit(ServerEvent.Migrate, { reason: 'room draining', reconnectAfterMs: 500 });
      socket.disconnect(true);
      return;
    }

    if (room.isFull && !room.hasPlayer(playerId)) {
      socket.emit(ServerEvent.Error, {
        code: 'ROOM_FULL',
        message: 'This room is full',
        retryable: true,
      });
      socket.disconnect(true);
      return;
    }

    void socket.join(roomId);
    room.addPlayer(playerId, socket.id, nickname);

    socket.emit(ServerEvent.Joined, {
      playerId,
      roomId,
      tickRate: config.TICK_RATE_HZ,
      snapshotRate: config.SNAPSHOT_RATE_HZ,
      worldRadius: 8_000,
      serverTime: Math.floor(room.world.elapsedMs),
    });

    log.info({ playerId, roomId, players: room.playerCount }, 'player joined');

    // Chat, ping and respawn each cost real work and none had a limiter. Chat
    // is the worst of them: it fans out to every socket in the room, so one
    // sender multiplies into N sends.
    const events = new EventGuard();

    // ---- Join (protocol check) --------------------------------------------

    socket.on(ClientEvent.Join, (payload, ack) => {
      // A stale browser tab after a deploy would otherwise desync silently
      // rather than reconnecting.
      if (!isProtocolCompatible(payload.protocolVersion)) {
        ack({
          code: 'PROTOCOL_MISMATCH',
          message: `Server speaks protocol ${PROTOCOL_VERSION}`,
          retryable: false,
        });
        socket.disconnect(true);
        return;
      }

      ack({
        playerId,
        roomId,
        tickRate: config.TICK_RATE_HZ,
        snapshotRate: config.SNAPSHOT_RATE_HZ,
        worldRadius: 8_000,
        serverTime: Math.floor(room.world.elapsedMs),
      });
    });

    // ---- Input -------------------------------------------------------------

    socket.on(ClientEvent.Input, (payload) => {
      const parsed = inputBatchSchema.safeParse(payload);
      if (!parsed.success) {
        droppedInputs.inc({ reason: 'malformed' });
        return;
      }

      const guard = getGuard(socket.id);
      const outcome = validateInputBatch(guard, parsed.data.commands, {
        now: Date.now(),
        // Clamped to one tick: a forged `dt` is the simplest speed hack there
        // is, and this is what makes it worthless.
        maxDtMs: TICK_INTERVAL_MS,
        ratePerSecond: config.MAX_INPUTS_PER_SECOND,
        burst: config.MAX_INPUTS_PER_SECOND,
      });

      for (const rejection of outcome.rejected) {
        droppedInputs.inc({ reason: rejection.reason });
      }

      for (const command of outcome.accepted) {
        room.applyInput(playerId, command);
      }

      if (shouldShadowban(guard)) {
        // Shadowban rather than kick: a cheater who is disconnected learns
        // which signal caught them and iterates against it.
        room.setShadowbanned(playerId, true);
        log.warn(
          { playerId, suspicion: guard.suspicion, rejections: guard.rejections },
          'player shadowbanned',
        );
      }
    });

    // ---- Heartbeat / latency ------------------------------------------------

    socket.on(ClientEvent.Ping, (clientTime, ack) => {
      if (!events.allow('ping', Date.now())) return;

      // The client derives RTT and clock offset from this. Interpolation
      // renders at `serverTime - delay`, so a wrong offset shows up as
      // permanent stutter rather than an obvious clock bug.
      ack(Math.floor(room.world.elapsedMs));
      void clientTime;
    });

    // ---- Respawn ------------------------------------------------------------

    socket.on(ClientEvent.Respawn, (ack) => {
      if (!events.allow('respawn', Date.now())) return;

      room.respawn(playerId);
      ack({
        playerId,
        roomId,
        tickRate: config.TICK_RATE_HZ,
        snapshotRate: config.SNAPSHOT_RATE_HZ,
        worldRadius: 8_000,
        serverTime: Math.floor(room.world.elapsedMs),
      });
    });

    // ---- Chat ---------------------------------------------------------------

    socket.on(ClientEvent.Chat, (payload) => {
      // Parsed rather than read directly: the previous version reached into
      // `payload.body`, so a null payload threw inside the handler.
      const parsed = chatPayloadSchema.safeParse(payload);
      if (!parsed.success) return;

      if (!events.allow('chat', Date.now())) return;

      // Strips zero-width and bidi-override characters, which render as
      // nothing and let a sender spoof another player's name while passing
      // every length check.
      const body = sanitiseChat(parsed.data.body);
      if (body === null) return;

      // Shadowbanned players still see their own messages; nobody else does.
      if (room.isShadowbanned(playerId)) {
        socket.emit(ServerEvent.Chat, { playerId, nickname, body });
        return;
      }

      io.to(roomId).emit(ServerEvent.Chat, { playerId, nickname, body });
    });

    // ---- Leave / disconnect --------------------------------------------------

    socket.on(ClientEvent.Leave, () => {
      room.removePlayer(playerId);
      socket.disconnect(true);
    });

    socket.on('disconnect', (reason) => {
      socketEvents.inc({ event: 'disconnect' });
      releaseGuard(socket.id);

      // Grace window, not removal. The room's tick evicts the seat if the
      // player does not come back.
      room.markDisconnected(playerId, Date.now());
      log.info({ playerId, roomId, reason }, 'player disconnected');
    });
  });

  // Suspicion decays so an honest player with one bad afternoon of packet loss
  // is not permanently marked.
  const decayTimer = setInterval(() => {
    for (const [, socket] of io.sockets.sockets) {
      decaySuspicion(getGuard(socket.id), 2);
    }
  }, 10_000);
  decayTimer.unref();
}
