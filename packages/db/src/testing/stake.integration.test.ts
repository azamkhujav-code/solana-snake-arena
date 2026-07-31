import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, seedUser, type TestDatabase } from './pglite.js';

/**
 * Entry-fee staking, against a real Postgres.
 *
 * Reservations are the boundary between "a player says they want to play" and
 * "the platform is holding their money". Every property here is one the
 * application deliberately does not re-check in code — the unique index makes a
 * double-clicked join idempotent, and the transaction makes a concurrent join
 * and withdrawal impossible to interleave badly.
 *
 * The service functions take a `PrismaClient`, which cannot point at PGlite.
 * So these exercise the same SQL the service issues, through the same real
 * database, asserting the constraints rather than the TypeScript.
 */
describe('stake reservations', () => {
  let test: TestDatabase;
  let userId: string;
  let custodyId: string;

  beforeAll(async () => {
    test = await createTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await test.close();
  });

  beforeEach(async () => {
    await test.truncate();
    userId = await seedUser(test);

    const rows = await test.query<{ id: string }>(
      `INSERT INTO pool_accounts (id, kind, name, owner_user_id, balance_lamports, reserved_lamports, updated_at)
       VALUES (gen_random_uuid(), 'USER_CUSTODY'::pool_account_kind, $1, $2, 1000000000, 0, now())
       RETURNING id`,
      [`custody:${userId}`, userId],
    );
    custodyId = rows[0]!.id;
  });

  /**
   * Reads lamport columns as text and parses them.
   *
   * PGlite maps `int8` adaptively — a JS number when the value fits in a safe
   * integer, a bigint when it does not. Asking for text makes every assertion
   * driver-independent and, more importantly, matches how the application must
   * treat these values anyway.
   */
  async function readCustody(): Promise<{ balance: bigint; reserved: bigint }> {
    const [row] = await test.query<{ balance: string; reserved: string }>(
      `SELECT balance_lamports::text AS balance, reserved_lamports::text AS reserved
       FROM pool_accounts WHERE id = $1`,
      [custodyId],
    );
    return { balance: BigInt(row!.balance), reserved: BigInt(row!.reserved) };
  }

  /** Mirrors `reserveEntryFee`: check spendable, bump reserved, insert the row. */
  async function reserve(tierId: string, lamports: bigint): Promise<void> {
    const account = await readCustody();

    const spendable = account.balance - account.reserved;
    if (spendable < lamports) throw new Error('insufficient');

    await test.query(
      'UPDATE pool_accounts SET reserved_lamports = reserved_lamports + $1 WHERE id = $2',
      [lamports.toString(), custodyId],
    );
    await test.query(
      `INSERT INTO stake_reservations (id, user_id, tier_id, lamports)
       VALUES (gen_random_uuid(), $1, $2, $3)`,
      [userId, tierId, lamports.toString()],
    );
  }

  async function custody(): Promise<{ balance: bigint; reserved: bigint; spendable: bigint }> {
    const account = await readCustody();
    return { ...account, spendable: account.balance - account.reserved };
  }

  it('reserves without moving the balance', async () => {
    // The money stays the player's. It simply stops being spendable, which is
    // what lets a match lock it later without a second balance check.
    await reserve('gold', 100_000_000n);

    const after = await custody();
    expect(after.balance).toBe(1_000_000_000n);
    expect(after.reserved).toBe(100_000_000n);
    expect(after.spendable).toBe(900_000_000n);
  });

  it('refuses a second reservation for the same tier', async () => {
    // The constraint that makes a double-clicked join idempotent rather than
    // charging twice. Enforced by a unique index, not an `if`, so two
    // concurrent joins cannot both pass a check and both insert.
    await reserve('gold', 100_000_000n);

    const error = await test.expectFailure(
      `INSERT INTO stake_reservations (id, user_id, tier_id, lamports)
       VALUES (gen_random_uuid(), $1, 'gold', 100000000)`,
      [userId],
    );

    expect(error).toMatch(/duplicate key|unique/i);
  });

  it('allows the same player to stake different tiers', async () => {
    await reserve('gold', 100_000_000n);
    await reserve('platinum', 500_000_000n);

    const after = await custody();
    expect(after.reserved).toBe(600_000_000n);
    expect(after.spendable).toBe(400_000_000n);
  });

  it('refuses a stake the spendable balance cannot cover', async () => {
    // The whole point: a player cannot queue for three rooms on one balance.
    await reserve('whale', 900_000_000n);

    await expect(reserve('diamond', 200_000_000n)).rejects.toThrow(/insufficient/);
  });

  it('counts reserved lamports as unspendable, not merely tracked', async () => {
    await reserve('whale', 1_000_000_000n);

    const after = await custody();
    expect(after.spendable).toBe(0n);
    // Balance is untouched — a withdrawal path reading `balance` alone would
    // happily pay this out, which is why every check uses spendable.
    expect(after.balance).toBe(1_000_000_000n);
  });

  it('releases a reservation back to spendable', async () => {
    await reserve('gold', 100_000_000n);

    await test.query(
      'UPDATE pool_accounts SET reserved_lamports = reserved_lamports - 100000000 WHERE id = $1',
      [custodyId],
    );
    await test.query('DELETE FROM stake_reservations WHERE user_id = $1 AND tier_id = $2', [
      userId,
      'gold',
    ]);

    const after = await custody();
    expect(after.reserved).toBe(0n);
    expect(after.spendable).toBe(1_000_000_000n);
  });

  it('consumes a stake by debiting the balance, not just the reservation', async () => {
    // Consuming is spending, releasing is handing back. Confusing the two would
    // either double-pay or double-charge, so the two paths must differ here.
    await reserve('gold', 100_000_000n);

    await test.query(
      `UPDATE pool_accounts
       SET balance_lamports = balance_lamports - 100000000,
           reserved_lamports = reserved_lamports - 100000000
       WHERE id = $1`,
      [custodyId],
    );
    await test.query('DELETE FROM stake_reservations WHERE tier_id = $1', ['gold']);

    const after = await custody();
    expect(after.balance).toBe(900_000_000n);
    expect(after.reserved).toBe(0n);
  });

  it('cascades reservations when a user is deleted', async () => {
    // Unlike transactions, a reservation is not financial history — it is a
    // live commitment. A deleted account has none.
    await reserve('gold', 100_000_000n);
    await test.query('DELETE FROM users WHERE id = $1', [userId]);

    const rows = await test.query<{ total: string }>(
      'SELECT count(*)::text AS total FROM stake_reservations',
    );
    expect(rows[0]?.total).toBe('0');
  });

  it('sums a full field to the expected pot', async () => {
    // The check `closeLobby` runs before starting a match: staked total must
    // equal fee × players, or somebody plays free.
    const fee = 100_000_000n;
    const players = 6;

    for (let i = 0; i < players; i += 1) {
      const other = await seedUser(test, { username: `p${i}` });
      await test.query(
        `INSERT INTO stake_reservations (id, user_id, tier_id, lamports)
         VALUES (gen_random_uuid(), $1, 'gold', $2)`,
        [other, fee.toString()],
      );
    }

    const [row] = await test.query<{ total: string }>(
      `SELECT COALESCE(SUM(lamports), 0)::text AS total
       FROM stake_reservations WHERE tier_id = 'gold'`,
    );

    expect(BigInt(row!.total)).toBe(fee * BigInt(players));
  });
});
