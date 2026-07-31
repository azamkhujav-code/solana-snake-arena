import {
  GameStatus,
  SettlementStatus,
  type PoolAccountKind,
  type PrismaClient,
} from '@arena/db';
import { ROOM_TIERS, type RoomTier } from '@arena/protocol';

/**
 * Reads the wallet holding each tier's current match pot.
 *
 * Every match gets its own vault address, derived from the match id, so the pot
 * is never commingled and a player can name the exact account their entry fee
 * went into. This assembles the player-facing view of that account.
 *
 * The numbers come from three different places on purpose, because they answer
 * three different questions and only one of them is "what is in the wallet":
 *
 *  - Reservations live against each player's custody balance and have not moved
 *    yet. Entry fees are consumed at *launch*, not at join, so that a lobby that
 *    never reaches its minimum costs nobody anything.
 *  - The escrow pool account holds the pot once the match starts.
 *  - The rake is a property of the room, applied at settlement.
 *
 * Reporting the reservation total as the wallet balance would be the obvious
 * simplification and would be a lie for most of a lobby's life — it would show
 * a funded wallet before any money had moved, and would drop when a player left
 * a wallet that is supposed to be immutable once sealed.
 */

export interface MatchWallet {
  tierId: string;
  gameId: string | null;
  address: string | null;
  balanceLamports: bigint;
  committedLamports: bigint;
  prizeLamports: bigint;
  rakeBps: number;
  onChain: boolean;
}

const BPS_DENOMINATOR = 10_000n;

/**
 * The winner's share of a pot.
 *
 * Integer arithmetic throughout, rounding the rake down so the remainder lands
 * with the player rather than the house. Floating point would be wrong here for
 * the ordinary reason — lamport counts exceed the exact-integer range of a
 * double, and a pot that is off by one lamport does not reconcile.
 */
export function prizeAfterRake(potLamports: bigint, rakeBps: number): bigint {
  if (potLamports <= 0n) return 0n;
  const rake = (potLamports * BigInt(rakeBps)) / BPS_DENOMINATOR;
  return potLamports - rake;
}

/** The game whose pot a tier's players are currently contributing to. */
const LIVE_GAME_STATUSES = [GameStatus.PENDING, GameStatus.RUNNING] as const;

export async function listMatchWallets(prisma: PrismaClient): Promise<MatchWallet[]> {
  // One query per concern rather than per tier: seven round trips to render one
  // board is the kind of thing that looks fine locally and falls over under a
  // polling client.
  const [games, reservations] = await Promise.all([
    prisma.game.findMany({
      where: { status: { in: [...LIVE_GAME_STATUSES] }, room: { code: { in: TIER_CODES } } },
      orderBy: { startedAt: 'desc' },
      select: {
        id: true,
        potLamports: true,
        settlementStatus: true,
        onchainMatchPda: true,
        room: { select: { code: true, rakeBps: true } },
        escrow: { select: { balanceLamports: true, onchainAddress: true, kind: true } },
      },
    }),
    prisma.stakeReservation.groupBy({
      by: ['tierId'],
      _sum: { lamports: true },
    }),
  ]);

  // Newest first, so the first hit per tier is the live one. A tier can briefly
  // have two live games when a cycle overlaps the previous match's settlement.
  const gameByTier = new Map<string, (typeof games)[number]>();
  for (const game of games) {
    if (!gameByTier.has(game.room.code)) gameByTier.set(game.room.code, game);
  }

  const committedByTier = new Map<string, bigint>(
    reservations.map((row) => [row.tierId, row._sum.lamports ?? 0n]),
  );

  return ROOM_TIERS.map((tier) => buildWallet(tier, gameByTier.get(tier.id), committedByTier));
}

const TIER_CODES = ROOM_TIERS.map((tier) => tier.id);

function buildWallet(
  tier: RoomTier,
  game: GameRow | undefined,
  committedByTier: Map<string, bigint>,
): MatchWallet {
  const committed = committedByTier.get(tier.id) ?? 0n;

  // Free rooms hold no funds, so there is no wallet to point at. Reporting a
  // zero-balance address would invite the question of why it is always empty.
  if (tier.entryFeeLamports === 0n) {
    return {
      tierId: tier.id,
      gameId: game?.id ?? null,
      address: null,
      balanceLamports: 0n,
      committedLamports: 0n,
      prizeLamports: 0n,
      rakeBps: 0,
      onChain: false,
    };
  }

  // The escrow account is the authority on what the wallet holds. `potLamports`
  // on the game is a denormalised copy written at launch; preferring the account
  // means a payout that has already left is reflected rather than reported as
  // still sitting there.
  const balance = game?.escrow?.balanceLamports ?? 0n;
  const rakeBps = game?.room.rakeBps ?? tier.rakeBps;

  return {
    tierId: tier.id,
    gameId: game?.id ?? null,
    address: game?.escrow?.onchainAddress ?? game?.onchainMatchPda ?? null,
    balanceLamports: balance,
    committedLamports: committed,
    prizeLamports: prizeAfterRake(balance, rakeBps),
    rakeBps,
    // PENDING means `create_room` landed on chain. FAILED means the address is
    // derived but nothing was initialised, so the pot is ledger-only — a
    // distinction the player is entitled to know before they look the address
    // up and find an empty account.
    onChain: game?.settlementStatus === SettlementStatus.PENDING,
  };
}

interface GameRow {
  id: string;
  potLamports: bigint;
  settlementStatus: SettlementStatus;
  onchainMatchPda: string | null;
  room: { code: string; rakeBps: number };
  escrow: { balanceLamports: bigint; onchainAddress: string | null; kind: PoolAccountKind } | null;
}
