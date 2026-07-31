import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, seedPoolAccount, seedUser, type TestDatabase } from './pglite.js';

/**
 * The ledger invariant, across a full match.
 *
 * `SUM(pool balances) == SUM(posted entries)` is the property the entire
 * double-entry design exists to make checkable. If it holds after money has
 * moved through staking and settlement, the books are provable; if it does not,
 * the treasury page reports drift and nobody can say where it came from.
 *
 * This exists because an earlier `consumeReservations` updated balances
 * directly with no `transactions` rows. Every stake taken would have shown up
 * as drift, and the check that was supposed to catch a ledger bug would instead
 * have been permanently red — which is the same as having no check at all.
 */
describe('ledger invariant through a match', () => {
  let test: TestDatabase;

  beforeAll(async () => {
    test = await createTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await test.close();
  });

  beforeEach(async () => {
    await test.truncate();
  });

  /** The exact comparison the reconciler and the treasury page make. */
  async function drift(): Promise<bigint> {
    const [pools] = await test.query<{ total: string }>(
      'SELECT COALESCE(SUM(balance_lamports), 0)::text AS total FROM pool_accounts',
    );
    const [ledger] = await test.query<{ total: string }>(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_lamports
                                ELSE -amount_lamports END), 0)::text AS total
       FROM transactions WHERE status = 'POSTED'`,
    );
    return BigInt(pools!.total) - BigInt(ledger!.total);
  }

  /** Posts a balanced pair of legs and moves both balances. */
  async function transfer(params: {
    from: string;
    to: string;
    amount: bigint;
    type: string;
    key: string;
    userId?: string | undefined;
  }): Promise<void> {
    const group = crypto.randomUUID();

    await test.query(
      'UPDATE pool_accounts SET balance_lamports = balance_lamports - $1 WHERE id = $2',
      [params.amount.toString(), params.from],
    );
    await test.query(
      'UPDATE pool_accounts SET balance_lamports = balance_lamports + $1 WHERE id = $2',
      [params.amount.toString(), params.to],
    );

    const [fromRow] = await test.query<{ balance: string }>(
      'SELECT balance_lamports::text AS balance FROM pool_accounts WHERE id = $1',
      [params.from],
    );
    const [toRow] = await test.query<{ balance: string }>(
      'SELECT balance_lamports::text AS balance FROM pool_accounts WHERE id = $1',
      [params.to],
    );

    await test.query(
      `INSERT INTO transactions
         (id, entry_group_id, type, direction, status, amount_lamports,
          balance_after_lamports, user_id, pool_account_id, idempotency_key)
       VALUES
         (gen_random_uuid(), $1, $2::transaction_type, 'DEBIT'::transaction_direction,
          'POSTED'::transaction_status, $3, $4, $5, $6, $7),
         (gen_random_uuid(), $1, $2::transaction_type, 'CREDIT'::transaction_direction,
          'POSTED'::transaction_status, $3, $8, $5, $9, $10)`,
      [
        group,
        params.type,
        params.amount.toString(),
        fromRow!.balance,
        params.userId ?? null,
        params.from,
        `${params.key}:debit`,
        toRow!.balance,
        params.to,
        `${params.key}:credit`,
      ],
    );
  }

  it('holds through deposit, stake and settlement', async () => {
    // A full match, end to end, in the shape the services actually post it.
    const external = await seedPoolAccount(test, { kind: 'EXTERNAL', name: 'external' });
    const rake = await seedPoolAccount(test, { kind: 'RAKE', name: 'rake' });

    const players: string[] = [];
    const custodies: string[] = [];

    for (let i = 0; i < 4; i += 1) {
      const user = await seedUser(test, { username: `p${i}` });
      players.push(user);
      custodies.push(
        await seedPoolAccount(test, {
          kind: 'USER_CUSTODY',
          name: `custody:${user}`,
          ownerUserId: user,
        }),
      );
    }

    const escrow = await seedPoolAccount(test, { kind: 'GAME_ESCROW', name: 'escrow:game-1' });

    expect(await drift()).toBe(0n);

    // 1. Each player deposits 1 SOL. EXTERNAL goes negative, which is the one
    //    account allowed to — it mirrors net inflow, not funds held.
    const deposit = 1_000_000_000n;
    for (const [i, custody] of custodies.entries()) {
      await transfer({
        from: external,
        to: custody,
        amount: deposit,
        type: 'DEPOSIT',
        key: `dep:${i}`,
        userId: players[i],
      });
    }
    expect(await drift()).toBe(0n);

    // 2. Each stakes 0.1 SOL into the room's escrow.
    const fee = 100_000_000n;
    for (const [i, custody] of custodies.entries()) {
      await transfer({
        from: custody,
        to: escrow,
        amount: fee,
        type: 'ENTRY_FEE',
        key: `stake:${i}`,
        userId: players[i],
      });
    }
    expect(await drift()).toBe(0n);

    const pot = fee * 4n;
    const platformFee = (pot * 1_000n) / 10_000n; // 10%
    const prize = pot - platformFee;

    // 3. Settle: the whole prize to one winner, the fee out to rake.
    await transfer({
      from: escrow,
      to: custodies[0]!,
      amount: prize,
      type: 'PAYOUT',
      key: 'settle:winner',
      userId: players[0],
    });
    await transfer({
      from: escrow,
      to: rake,
      amount: platformFee,
      type: 'RAKE',
      key: 'settle:rake',
    });

    expect(await drift()).toBe(0n);

    // The escrow is empty: every lamport that entered the pot has left it.
    const [escrowRow] = await test.query<{ balance: string }>(
      'SELECT balance_lamports::text AS balance FROM pool_accounts WHERE id = $1',
      [escrow],
    );
    expect(escrowRow!.balance).toBe('0');

    // Winner take all, minus 10%.
    const [winnerRow] = await test.query<{ balance: string }>(
      'SELECT balance_lamports::text AS balance FROM pool_accounts WHERE id = $1',
      [custodies[0]!],
    );
    expect(BigInt(winnerRow!.balance)).toBe(deposit - fee + prize);

    const [rakeRow] = await test.query<{ balance: string }>(
      'SELECT balance_lamports::text AS balance FROM pool_accounts WHERE id = $1',
      [rake],
    );
    expect(BigInt(rakeRow!.balance)).toBe(platformFee);
    expect(platformFee).toBe(40_000_000n); // 10% of 0.4 SOL
  });

  it('holds when an abandoned match hands the pot back', async () => {
    // The other ending. A match that takes entry fees and never produces a
    // result has to return them, and the return trip is held to the same
    // standard as the payout: balanced legs, and an escrow that ends empty.
    const players: string[] = [];
    const custodies: string[] = [];

    for (let i = 0; i < 3; i += 1) {
      const user = await seedUser(test, { username: `q${i}` });
      players.push(user);
      custodies.push(
        await seedPoolAccount(test, {
          kind: 'USER_CUSTODY',
          name: `custody:${user}`,
          ownerUserId: user,
          balance: 1_000_000_000n,
        }),
      );
    }

    const escrow = await seedPoolAccount(test, { kind: 'GAME_ESCROW', name: 'escrow:game-2' });
    const fee = 100_000_000n;
    const driftBefore = await drift();

    for (const [i, custody] of custodies.entries()) {
      await transfer({
        from: custody,
        to: escrow,
        amount: fee,
        type: 'ENTRY_FEE',
        key: `stake:game-2:${i}`,
        userId: players[i],
      });
    }

    // Refund every stake to the account it came from.
    for (const [i, custody] of custodies.entries()) {
      await transfer({
        from: escrow,
        to: custody,
        amount: fee,
        type: 'REFUND',
        key: `refund:game-2:${players[i]}`,
        userId: players[i],
      });
    }

    expect(await drift()).toBe(driftBefore);

    const [escrowRow] = await test.query<{ balance: string }>(
      'SELECT balance_lamports::text AS balance FROM pool_accounts WHERE id = $1',
      [escrow],
    );
    expect(escrowRow!.balance).toBe('0');

    // Every player is exactly where they started: a cancelled match costs the
    // people in it nothing.
    for (const custody of custodies) {
      const [row] = await test.query<{ balance: string }>(
        'SELECT balance_lamports::text AS balance FROM pool_accounts WHERE id = $1',
        [custody],
      );
      expect(BigInt(row!.balance)).toBe(1_000_000_000n);
    }
  });

  it('refuses a second refund for the same player and game', async () => {
    // The constraint, not the code, is what stops a retried cancellation paying
    // the pot back twice — so it is the constraint that gets asserted. An
    // operator clicking cancel again, or a worker re-running a failed stage,
    // both arrive here.
    const user = await seedUser(test);
    const custody = await seedPoolAccount(test, {
      kind: 'USER_CUSTODY',
      name: `custody:${user}`,
      ownerUserId: user,
    });
    const escrow = await seedPoolAccount(test, {
      kind: 'GAME_ESCROW',
      name: 'escrow:game-3',
      balance: 100_000_000n,
    });

    await transfer({
      from: escrow,
      to: custody,
      amount: 100_000_000n,
      type: 'REFUND',
      key: `refund:game-3:${user}`,
      userId: user,
    });

    const afterFirst = await drift();

    await expect(
      test.query(
        `INSERT INTO transactions
           (id, entry_group_id, type, direction, status, amount_lamports,
            balance_after_lamports, user_id, pool_account_id, idempotency_key)
         VALUES
           (gen_random_uuid(), gen_random_uuid(), 'REFUND'::transaction_type,
            'CREDIT'::transaction_direction, 'POSTED'::transaction_status,
            100000000, 200000000, $1, $2, $3)`,
        [user, custody, `refund:game-3:${user}:credit`],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);

    expect(await drift()).toBe(afterFirst);
  });

  it('reports drift when a balance moves without a ledger entry', async () => {
    // The bug this suite exists for. Updating a balance directly is exactly
    // what `consumeReservations` used to do, and the invariant must catch it —
    // otherwise the check is decorative.
    const user = await seedUser(test);
    const custody = await seedPoolAccount(test, {
      kind: 'USER_CUSTODY',
      name: `custody:${user}`,
      ownerUserId: user,
      balance: 500n,
    });

    // Seeded with a balance and no entries: already drifted by construction.
    expect(await drift()).toBe(500n);

    await test.query('UPDATE pool_accounts SET balance_lamports = 0 WHERE id = $1', [custody]);
    expect(await drift()).toBe(0n);
  });
});
