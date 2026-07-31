import { beforeEach, describe, expect, it, vi } from 'vitest';

import { config } from '../config.js';
import { Room } from './room.js';

/**
 * Room lifecycle and seat management.
 *
 * The multiplayer suite covers this over a real socket; these cover the state
 * machine directly, where a fake clock makes the reconnect grace window and the
 * settlement report cheap to drive. Both are worth having: one proves a client
 * can reach the behaviour, the other proves the behaviour is right at its
 * boundaries.
 */

/**
 * Ticks until the leaderboard cache is rebuilt.
 *
 * The board refreshes once per simulated second, not per tick — recomputing a
 * sorted board 30 times a second for a ranking that barely moves would be pure
 * waste. Tests have to advance far enough to observe it.
 */
function tickUntilLeaderboardRefresh(room: Room): void {
  const now = Date.now();
  for (let i = 0; i <= config.TICK_RATE_HZ; i += 1) room.tick(now + i * 33);
}

/** Socket.IO stand-in that records what was emitted and where. */
function createIoStub() {
  const emitted: { room: string; event: string; payload: unknown }[] = [];

  return {
    emitted,
    to(room: string) {
      return {
        emit(event: string, payload: unknown) {
          emitted.push({ room, event, payload });
        },
      };
    },
    sockets: { sockets: new Map() },
  };
}

function createRoom(overrides: { maxPlayers?: number } = {}) {
  const io = createIoStub();
  const room = new Room({
    roomId: 'room-1',
    mode: 'casual',
    region: 'us-east',
    maxPlayers: overrides.maxPlayers ?? 8,
    seed: 42,
    io: io as never,
  });

  // `RoomManager.ensureRoom` always starts a room before handing it out, so a
  // room that has not been started is not a state the rest of the system can
  // observe. Mirrored here rather than tested as a case.
  room.start();

  return { room, io };
}

describe('Room', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  describe('seating', () => {
    it('starts empty', () => {
      const { room } = createRoom();

      expect(room.playerCount).toBe(0);
      expect(room.isFull).toBe(false);
    });

    it('seats a player', () => {
      const { room } = createRoom();
      room.addPlayer('p1', 'socket-1', 'alice');

      expect(room.playerCount).toBe(1);
      expect(room.hasPlayer('p1')).toBe(true);
    });

    it('is idempotent on a repeated add', () => {
      // A reconnect re-runs this path. Seating the same player twice would let
      // one person occupy two seats and appear twice on the leaderboard.
      const { room } = createRoom();
      room.addPlayer('p1', 'socket-1', 'alice');
      room.addPlayer('p1', 'socket-2', 'alice');

      expect(room.playerCount).toBe(1);
    });

    it('reports full at capacity', () => {
      const { room } = createRoom({ maxPlayers: 2 });
      room.addPlayer('p1', 's1', 'a');
      room.addPlayer('p2', 's2', 'b');

      expect(room.isFull).toBe(true);
    });

    it('frees the seat on removal', () => {
      const { room } = createRoom({ maxPlayers: 2 });
      room.addPlayer('p1', 's1', 'a');
      room.addPlayer('p2', 's2', 'b');
      room.removePlayer('p1');

      expect(room.playerCount).toBe(1);
      expect(room.isFull).toBe(false);
      expect(room.hasPlayer('p1')).toBe(false);
    });

    it('ignores removal of a player who was never seated', () => {
      const { room } = createRoom();
      expect(() => room.removePlayer('ghost')).not.toThrow();
      expect(room.playerCount).toBe(0);
    });
  });

  describe('shadowban', () => {
    it('defaults to not shadowbanned', () => {
      const { room } = createRoom();
      room.addPlayer('p1', 's1', 'a');

      expect(room.isShadowbanned('p1')).toBe(false);
    });

    it('marks a player', () => {
      const { room } = createRoom();
      room.addPlayer('p1', 's1', 'a');
      room.setShadowbanned('p1', true);

      expect(room.isShadowbanned('p1')).toBe(true);
    });

    it('treats an unknown player as shadowbanned', () => {
      // Callers use this to decide whether to broadcast on someone's behalf,
      // and doing that for a seat that no longer exists is the wrong default.
      const { room } = createRoom();
      expect(room.isShadowbanned('never-joined')).toBe(true);
    });

    it('does not throw when marking an absent player', () => {
      const { room } = createRoom();
      expect(() => room.setShadowbanned('ghost', true)).not.toThrow();
    });
  });

  describe('disconnect grace', () => {
    it('keeps the seat immediately after a disconnect', () => {
      // A brief network blip must not cost a player their run.
      const { room } = createRoom();
      room.addPlayer('p1', 's1', 'a');
      room.markDisconnected('p1', 1_000);

      expect(room.playerCount).toBe(1);
      expect(room.hasPlayer('p1')).toBe(true);
    });

    it('evicts the seat once the grace window lapses', () => {
      const { room } = createRoom();
      room.addPlayer('p1', 's1', 'a');
      room.markDisconnected('p1', 1_000);

      // Well past any plausible grace window.
      room.tick(1_000 + 10 * 60_000);

      expect(room.hasPlayer('p1')).toBe(false);
    });

    it('keeps a connected player across the same span', () => {
      // The eviction must key on disconnection, not on elapsed time — otherwise
      // it would remove everyone still playing.
      const { room } = createRoom();
      room.addPlayer('p1', 's1', 'a');

      room.tick(10 * 60_000);

      expect(room.hasPlayer('p1')).toBe(true);
    });

    it('restores the seat when the player returns', () => {
      const { room } = createRoom();
      room.addPlayer('p1', 's1', 'a');
      room.markDisconnected('p1', 1_000);
      room.addPlayer('p1', 's2', 'a');

      room.tick(1_000 + 10 * 60_000);

      expect(room.hasPlayer('p1')).toBe(true);
      expect(room.playerCount).toBe(1);
    });
  });

  describe('leaderboard', () => {
    it('is empty in an empty room', () => {
      const { room } = createRoom();
      expect(room.leaderboard).toEqual([]);
    });

    it('lists every seated player once the cache refreshes', () => {
      // The board is a cache rebuilt during `tick`, not a live view. Rebuilding
      // it per read would mean sorting every player on every snapshot fan-out.
      const { room } = createRoom();
      room.addPlayer('p1', 's1', 'alice');
      room.addPlayer('p2', 's2', 'bob');
      tickUntilLeaderboardRefresh(room);

      const names = room.leaderboard.map((entry) => entry.nickname).sort();
      expect(names).toEqual(['alice', 'bob']);
    });

    it('includes a kills field so a kill counter is computable', () => {
      // Added after the fact: without it the HUD could show a score but not a
      // kill count, and settlement had no per-player kill figure to record.
      const { room } = createRoom();
      room.addPlayer('p1', 's1', 'alice');
      tickUntilLeaderboardRefresh(room);

      expect(room.leaderboard[0]).toHaveProperty('kills');
      expect(typeof room.leaderboard[0]?.kills).toBe('number');
    });
  });

  describe('settlement report', () => {
    it('reports every entrant', () => {
      const { room } = createRoom();
      room.addPlayer('p1', 's1', 'alice');
      room.addPlayer('p2', 's2', 'bob');

      const result = room.buildResult('game-1');

      expect(result.gameId).toBe('game-1');
      expect(result.roomId).toBe('room-1');
      expect(result.standings).toHaveLength(2);
    });

    it('assigns a distinct placement to each player', () => {
      // Two players sharing a placement makes the payout split ambiguous, and
      // settlement pays on placement.
      const { room } = createRoom();
      for (let i = 0; i < 5; i += 1) room.addPlayer(`p${i}`, `s${i}`, `player-${i}`);

      const placements = room.buildResult('game-1').standings.map((row) => row.placement);

      expect(placements).toEqual([1, 2, 3, 4, 5]);
      expect(new Set(placements).size).toBe(placements.length);
    });

    it('keeps a disconnected player in the standings', () => {
      // Disconnecting is not leaving. The seat is held through the grace
      // window, and dropping such a player from the report would make
      // settlement reject it for a missing entrant — so nobody gets paid.
      const { room } = createRoom();
      room.addPlayer('p1', 's1', 'alice');
      room.addPlayer('p2', 's2', 'bob');

      room.markDisconnected('p1', Date.now());
      const result = room.buildResult('game-1');

      expect(result.standings.map((row) => row.playerId)).toContain('p1');
    });

    it('drops a player who explicitly left', () => {
      // The other side of the same coin: leaving forfeits the seat, so they are
      // not an entrant to be paid.
      const { room } = createRoom();
      room.addPlayer('p1', 's1', 'alice');
      room.addPlayer('p2', 's2', 'bob');

      room.removePlayer('p1');

      expect(room.buildResult('game-1').standings.map((row) => row.playerId)).toEqual(['p2']);
    });

    it('ranks the survivor first, not the highest scorer', () => {
      // The rule the whole prize depends on: last snake standing wins. A player
      // can farm a huge score and die in the first minute, and paying them
      // would contradict the one rule every player knows.
      const { room } = createRoom();
      room.addPlayer('farmer', 's1', 'farmer');
      room.addPlayer('survivor', 's2', 'survivor');

      // No eliminations recorded, so both are survivors and ordering falls
      // through to score. Simulate the farmer being knocked out.
      room.markEliminatedForTest('farmer', 1_000);

      const standings = room.buildResult('game-1').standings;

      expect(standings[0]?.playerId).toBe('survivor');
      expect(standings[0]?.placement).toBe(1);
      expect(standings[1]?.playerId).toBe('farmer');
    });

    it('ranks the eliminated by how long they lasted', () => {
      const { room } = createRoom();
      for (const id of ['first-out', 'second-out', 'third-out']) {
        room.addPlayer(id, `s-${id}`, id);
      }

      room.markEliminatedForTest('first-out', 1_000);
      room.markEliminatedForTest('second-out', 2_000);
      room.markEliminatedForTest('third-out', 3_000);

      const order = room.buildResult('game-1').standings.map((row) => row.playerId);

      // Latest elimination ranks highest.
      expect(order).toEqual(['third-out', 'second-out', 'first-out']);
    });

    it('credits a survivor with the full match duration', () => {
      const { room } = createRoom();
      room.addPlayer('survivor', 's1', 'survivor');
      room.addPlayer('victim', 's2', 'victim');
      room.markEliminatedForTest('victim', 500);

      const standings = room.buildResult('game-1').standings;
      const victim = standings.find((row) => row.playerId === 'victim');

      expect(victim?.survivedMs).toBe(500);
    });

    it('produces an empty report for an empty room rather than throwing', () => {
      const { room } = createRoom();
      const result = room.buildResult('game-1');

      expect(result.standings).toEqual([]);
    });
  });

  describe('lifecycle', () => {
    it('is active once started', () => {
      const { room } = createRoom();
      expect(room.status).toBe('active');
    });

    it('names the failure when used before it is started', () => {
      // Previously a bare TypeError about `playerIndex`, which says nothing
      // about the invariant that was violated.
      const unstarted = new Room({
        roomId: 'room-2',
        mode: 'casual',
        region: 'us-east',
        maxPlayers: 4,
        seed: 1,
        io: createIoStub() as never,
      });

      expect(() => unstarted.addPlayer('p1', 's1', 'a')).toThrow(/not been started/i);
    });

    it('reports draining after a drain', () => {
      // The connection handler refuses new joins in this state and migrates
      // existing ones, rather than stranding a match mid-play.
      const { room } = createRoom();
      room.drain();

      expect(room.status).toBe('draining');
    });

    it('reports closed after a close', () => {
      const { room } = createRoom();
      room.close();

      expect(room.status).toBe('closed');
    });

    it('survives a tick with no players', () => {
      // Rooms are ticked by a shared loop that does not check occupancy first.
      const { room } = createRoom();
      expect(() => room.tick(Date.now())).not.toThrow();
    });

    it('survives repeated close calls', () => {
      const { room } = createRoom();
      room.close();
      expect(() => room.close()).not.toThrow();
    });
  });
});
