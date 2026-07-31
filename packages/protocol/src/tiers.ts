/**
 * The seven rooms.
 *
 * A fixed ladder rather than user-created rooms: with free-form entry fees the
 * player base fragments across dozens of near-identical lobbies and none of
 * them ever fills. Seven tiers is few enough that every one reaches its minimum
 * during normal traffic.
 *
 * `minPlayers` is the auto-start threshold, not a hard floor — a lobby that
 * reaches it begins a countdown, and anyone joining during the countdown still
 * gets in. It is one on the free room and two on every paid one.
 *
 * Lives in `@arena/protocol` rather than in the lobby because two consumers
 * need it and they must not disagree: the matchmaker runs the live queues from
 * it, and the database seed writes the `rooms` rows from it. Two copies would
 * eventually differ on an entry fee, and the symptom is a player charged one
 * price for a room that advertises another.
 */

export const LAMPORTS_PER_SOL = 1_000_000_000n;

const sol = (value: number): bigint =>
  (BigInt(Math.round(value * 1_000)) * LAMPORTS_PER_SOL) / 1_000n;

export interface RoomTier {
  id: string;
  name: string;
  /** Entry fee in lamports. Zero means free to play. */
  entryFeeLamports: bigint;
  /**
   * Players required before the countdown starts.
   *
   * Two on every paid tier: a wagered match needs an opponent and nothing more.
   * A higher floor makes a room look busier when it fills, but it also means a
   * tier that never reaches its threshold never runs at all — and an empty
   * high-stakes room is worse than a small one.
   *
   * One on the free tier. Nothing is staked there, so a solo run costs no one
   * anything, and it is the room a first-time player lands in — making them
   * wait for a stranger to show up before they can move a snake is the worst
   * possible first impression.
   *
   * The cost is that the free room matches people up less often: a lone player
   * launches after `countdownSeconds`, and because a launching lobby rejects
   * joins and then resets, anyone arriving after that starts a fresh lobby of
   * their own rather than joining the match in progress. The countdown is the
   * only window in which two players meet, which is why the free room keeps a
   * countdown at all instead of starting instantly.
   */
  minPlayers: number;
  /**
   * Seat limit, or `null` for no limit.
   *
   * `null` everywhere: nobody is turned away from a room they want to play. The
   * caps that used to be here were arbitrary — 16 on the whale tier carried a
   * comment claiming the on-chain escrow account could not hold more
   * participants, which is not true. `Room` stores only fixed-size scalars and
   * each participant is a separate `room_player` PDA, so the account is the same
   * size whether two play or two thousand.
   *
   * The only real ceiling left is structural rather than policy: `player_count`
   * on chain is a `u16`, so 65,535. Nothing in the simulation is sized by player
   * count — snakes and food are dynamic maps — and the snapshot encoder already
   * writes entity counts as `u16`.
   */
  maxPlayers: number | null;
  /**
   * Platform fee in basis points, taken from the pot at settlement and paid
   * directly to the game owner's wallet.
   *
   * 1000 bps = 10%, which is also `MAX_FEE_BPS` on chain — the program refuses
   * anything higher, so this sits exactly at the ceiling. Free rooms take none;
   * there is no pot.
   */
  rakeBps: number;
  /**
   * How long the lobby counts down once `minPlayers` is reached.
   *
   * Ten seconds on the free room, where nothing is collected and the countdown
   * is only a moment to notice the match starting.
   *
   * Paid rooms need long enough to *pay*. The fee is charged when the countdown
   * begins, and a wallet approval is a human noticing a popup and pressing a
   * button — which does not happen in the two seconds left after the client
   * polls. At ten seconds the room launched while the prompt was still open, so
   * the match started with an empty vault and the player was never charged for
   * a game they had just entered.
   *
   * Paying marks the player ready, and a lobby where everyone is ready drops to
   * `readyCountdownSeconds` — so this is a ceiling for the slowest approver,
   * not a wait everyone sits through.
   */
  countdownSeconds: number;
  /**
   * Shortened countdown once every waiting player has readied up. Rewards a
   * lobby that is all present rather than making them wait out the full timer.
   */
  readyCountdownSeconds: number;
  description: string;
}

export const ROOM_TIERS: readonly RoomTier[] = Object.freeze([
  {
    id: 'practice',
    rakeBps: 0,
    name: 'Practice Pit',
    entryFeeLamports: 0n,
    minPlayers: 1,
    maxPlayers: null,
    countdownSeconds: 10,
    readyCountdownSeconds: 5,
    description: 'Free play. No stakes, no payouts.',
  },
  {
    id: 'bronze',
    rakeBps: 1_000,
    name: 'Bronze Arena',
    entryFeeLamports: sol(0.01),
    minPlayers: 2,
    maxPlayers: null,
    countdownSeconds: 45,
    readyCountdownSeconds: 5,
    description: 'Entry-level stakes.',
  },
  {
    id: 'silver',
    rakeBps: 1_000,
    name: 'Silver Arena',
    entryFeeLamports: sol(0.05),
    minPlayers: 2,
    maxPlayers: null,
    countdownSeconds: 45,
    readyCountdownSeconds: 5,
    description: 'A step up.',
  },
  {
    id: 'gold',
    rakeBps: 1_000,
    name: 'Gold Arena',
    entryFeeLamports: sol(0.1),
    minPlayers: 2,
    maxPlayers: null,
    countdownSeconds: 45,
    readyCountdownSeconds: 5,
    description: 'Serious stakes.',
  },
  {
    id: 'platinum',
    rakeBps: 1_000,
    name: 'Platinum Arena',
    entryFeeLamports: sol(0.5),
    minPlayers: 2,
    maxPlayers: null,
    countdownSeconds: 45,
    readyCountdownSeconds: 5,
    description: 'High stakes, smaller field.',
  },
  {
    id: 'diamond',
    rakeBps: 1_000,
    name: 'Diamond Arena',
    entryFeeLamports: sol(1),
    minPlayers: 2,
    maxPlayers: null,
    countdownSeconds: 45,
    readyCountdownSeconds: 5,
    description: 'For confident players.',
  },
  {
    id: 'whale',
    rakeBps: 1_000,
    name: "Whale's Deep",
    entryFeeLamports: sol(5),
    minPlayers: 2,
    maxPlayers: null,
    countdownSeconds: 45,
    readyCountdownSeconds: 5,
    description: 'The highest stakes on the board.',
  },
]);

const BY_ID = new Map(ROOM_TIERS.map((tier) => [tier.id, tier]));

export function getTier(id: string): RoomTier | undefined {
  return BY_ID.get(id);
}

export function requireTier(id: string): RoomTier {
  const tier = BY_ID.get(id);
  if (!tier) throw new Error(`Unknown room tier: ${id}`);
  return tier;
}

export const TIER_IDS: readonly string[] = ROOM_TIERS.map((tier) => tier.id);

/** Tiers a player can afford, cheapest first. */
export function affordableTiers(spendableLamports: bigint): RoomTier[] {
  return ROOM_TIERS.filter((tier) => tier.entryFeeLamports <= spendableLamports);
}
