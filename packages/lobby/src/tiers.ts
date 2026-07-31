/**
 * Re-exported from `@arena/protocol`.
 *
 * The tier table is a published contract, not lobby-internal configuration:
 * the matchmaker drives live queues from it and the database seed writes the
 * `rooms` rows from it. Keeping the definition in the shared kernel is what
 * stops those two disagreeing about what a room costs.
 */
export {
  affordableTiers,
  getTier,
  LAMPORTS_PER_SOL,
  requireTier,
  ROOM_TIERS,
  TIER_IDS,
  type RoomTier,
} from '@arena/protocol';
