import type { ReportedStanding } from './verify.js';

/**
 * Prize splitting.
 *
 * The on-chain `distribute_winnings` requires `sum(payouts)` to equal the
 * unlocked prize pool **exactly** — it rejects anything else. So every lamport
 * has to be accounted for, and the rounding remainder cannot simply be dropped.
 *
 * Pure integer maths on bigints throughout: a float split of a 5 SOL pot loses
 * lamports, and losing lamports here means the transaction fails.
 */

export interface PayoutShare {
  playerId: string;
  placement: number;
  lamports: bigint;
}

/**
 * Winner takes all.
 *
 * Last snake standing receives the entire prize pool — the pot after the
 * platform fee has already been taken. There is no second place.
 *
 * This replaced a tiered table that paid the top three to seven finishers. The
 * tiered version is gentler on a large room, but it is not the game being
 * built: "last player standing wins the pool" is a different product, and a
 * player who survives to the end and receives 40% of the pot has been told one
 * thing and paid another.
 *
 * Kept as a named constant rather than inlined so the on-chain instruction, the
 * off-chain ledger and the UI all read the same number.
 */
export const WINNER_SHARE_BPS = 10_000;

export const BPS_DENOMINATOR = 10_000n;

/**
 * The share table for a field of this size.
 *
 * Always a single entry: winner takes all, regardless of how many played. The
 * function is retained so the shape of `computePayouts` stays open to a future
 * table without rewriting its loop.
 */
export function tableFor(_playerCount: number): readonly number[] {
  return [WINNER_SHARE_BPS];
}

/**
 * Assigns the prize pool to the winner.
 *
 * Placement 1 is the last player standing — see `Room.buildResult`, which ranks
 * by elimination order rather than by score. Highest score and last survivor
 * are frequently different players, and the pot follows survival.
 *
 * Any rounding remainder goes to first place. With a single payee that is the
 * whole pool anyway, but the loop keeps the invariant explicit: the sum must
 * equal the prize pool exactly or the on-chain instruction rejects it.
 */
export function computePayouts(
  standings: readonly ReportedStanding[],
  prizePoolLamports: bigint,
): PayoutShare[] {
  if (standings.length === 0 || prizePoolLamports <= 0n) return [];

  const ordered = [...standings].sort((a, b) => a.placement - b.placement);
  const shares = tableFor(ordered.length);

  const paid = ordered.slice(0, shares.length);
  const payouts: PayoutShare[] = [];
  let allocated = 0n;

  for (let i = 0; i < paid.length; i += 1) {
    const standing = paid[i]!;
    const bps = BigInt(shares[i] ?? 0);
    const amount = (prizePoolLamports * bps) / BPS_DENOMINATOR;

    payouts.push({ playerId: standing.playerId, placement: standing.placement, lamports: amount });
    allocated += amount;
  }

  const remainder = prizePoolLamports - allocated;
  if (remainder !== 0n && payouts.length > 0) {
    payouts[0]!.lamports += remainder;
  }

  // A zero payout is rejected on-chain, so a share that rounded to nothing is
  // dropped rather than sent. Its lamports are already in first place's share
  // via the remainder above.
  return payouts.filter((payout) => payout.lamports > 0n);
}

/** Total of a payout set. Used to assert the on-chain invariant before sending. */
export function totalPayout(payouts: readonly PayoutShare[]): bigint {
  return payouts.reduce((sum, payout) => sum + payout.lamports, 0n);
}

/**
 * Splits the escrowed pot into prize and rake.
 *
 * Mirrors the program's `apply_bps` exactly — multiply, then divide — so the
 * figures match the chain to the lamport. Computing the rake as
 * `pot * (bps/10000)` in floating point drifts, and a drifted prize pool makes
 * every payout fail the sum check.
 */
export function splitPot(
  potLamports: bigint,
  rakeBps: number,
): { prizePool: bigint; rake: bigint } {
  const rake = (potLamports * BigInt(rakeBps)) / BPS_DENOMINATOR;
  return { prizePool: potLamports - rake, rake };
}

/**
 * On-chain `distribute_winnings` caps a single call at 8 winners.
 *
 * Kept in sync with `MAX_WINNERS_PER_DISTRIBUTION` in the program.
 */
export const MAX_WINNERS_PER_TX = 8;

export function withinTransactionLimit(payouts: readonly PayoutShare[]): boolean {
  return payouts.length <= MAX_WINNERS_PER_TX;
}
