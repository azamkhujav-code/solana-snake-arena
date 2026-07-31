import { ROOM_TIERS } from '@arena/protocol';

/**
 * The entry fee of the cheapest room that costs anything.
 *
 * The threshold for "funded enough to play a staked match". Computed from the
 * shared tier definitions rather than written down here, so adding a cheaper
 * rung to the ladder cannot leave the onboarding flow demanding more than the
 * board actually asks for.
 *
 * The free room is excluded deliberately — it is always playable, so including
 * it would make the answer zero and the deposit step would never appear.
 */
export function cheapestPaidEntryFee(): bigint {
  const paid = ROOM_TIERS.map((tier) => tier.entryFeeLamports).filter((fee) => fee > 0n);

  // Every rung being free is not a configuration that exists, but returning
  // zero is the right answer if it ever does: nothing is gated on a deposit.
  return paid.length === 0 ? 0n : paid.reduce((min, fee) => (fee < min ? fee : min));
}
