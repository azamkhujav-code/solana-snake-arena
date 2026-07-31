import { describe, expect, it } from 'vitest';

import { buildTicketClaims, mintTicket, TicketError, verifyTicket } from './ticket.js';

const SECRET = 'a-secret-that-is-at-least-32-characters-long';
const T0 = 1_700_000_000_000;

const claims = buildTicketClaims({
  playerId: 'player-1',
  wallet: 'So11111111111111111111111111111111111111112',
  roomId: 'room-abc',
  nodeId: 'realtime-3',
  nickname: 'snake',
  now: T0,
});

describe('mint and verify', () => {
  it('round-trips the claims', () => {
    const verified = verifyTicket(mintTicket(claims, SECRET), SECRET, T0 + 1_000);

    expect(verified.playerId).toBe('player-1');
    expect(verified.roomId).toBe('room-abc');
    expect(verified.nodeId).toBe('realtime-3');
  });

  it('binds the player to one specific room and node', () => {
    // This binding is why a client cannot pick its own room.
    const verified = verifyTicket(mintTicket(claims, SECRET), SECRET, T0);
    expect(verified.roomId).toBe(claims.roomId);
    expect(verified.nodeId).toBe(claims.nodeId);
  });

  it('rejects a ticket signed with a different secret', () => {
    const forged = mintTicket(claims, 'a-completely-different-secret-value-here');
    expect(() => verifyTicket(forged, SECRET, T0)).toThrow(TicketError);
  });

  it('rejects a tampered payload', () => {
    // Escalating to another room must not survive verification.
    const ticket = mintTicket(claims, SECRET);
    const [, signature] = ticket.split('.');

    const tampered = Buffer.from(
      JSON.stringify({ ...claims, roomId: 'someone-elses-room' }),
      'utf8',
    ).toString('base64url');

    expect(() => verifyTicket(`${tampered}.${signature}`, SECRET, T0)).toThrow(TicketError);
  });

  it('rejects an expired ticket', () => {
    const ticket = mintTicket(claims, SECRET);
    try {
      verifyTicket(ticket, SECRET, claims.expiresAt);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(TicketError);
      expect((error as TicketError).reason).toBe('expired');
    }
  });

  it('accepts right up to the expiry instant', () => {
    expect(() =>
      verifyTicket(mintTicket(claims, SECRET), SECRET, claims.expiresAt - 1),
    ).not.toThrow();
  });

  it('rejects malformed input rather than throwing something unhandled', () => {
    for (const bad of ['', 'nodot', 'a.b.c', '...']) {
      expect(() => verifyTicket(bad, SECRET, T0)).toThrow(TicketError);
    }
  });

  it('checks the signature before reading the payload', () => {
    // Parsing an unverified payload would mean acting on attacker-controlled
    // data, so a garbage payload with a bad signature must fail on signature.
    const bogus = `${Buffer.from('not json').toString('base64url')}.deadbeef`;
    try {
      verifyTicket(bogus, SECRET, T0);
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as TicketError).reason).toBe('bad-signature');
    }
  });

  it('gives each player a distinct ticket', () => {
    const other = buildTicketClaims({ ...claims, playerId: 'player-2', now: T0 });
    expect(mintTicket(claims, SECRET)).not.toBe(mintTicket(other, SECRET));
  });
});

describe('buildTicketClaims', () => {
  it('sets a short expiry', () => {
    expect(claims.expiresAt - claims.issuedAt).toBe(30_000);
  });
});

describe('game binding', () => {
  it('carries the game id when a launch prepared one', () => {
    // The realtime node reports standings under this id. Without it the node
    // knows only its own room id, and settlement waits for a report it can
    // never address — so the pot stays in escrow.
    const staked = buildTicketClaims({
      playerId: 'player-1',
      wallet: 'So11111111111111111111111111111111111111112',
      roomId: 'room-abc',
      nodeId: 'realtime-3',
      nickname: 'snake',
      gameId: 'game-42',
      now: T0,
    });

    expect(verifyTicket(mintTicket(staked, SECRET), SECRET, T0).gameId).toBe('game-42');
  });

  it('omits the game id entirely for direct entry', () => {
    // Serialised into the signed payload, so an explicit `undefined` would
    // change the bytes being signed.
    expect('gameId' in claims).toBe(false);
    expect(verifyTicket(mintTicket(claims, SECRET), SECRET, T0).gameId).toBeUndefined();
  });
});
