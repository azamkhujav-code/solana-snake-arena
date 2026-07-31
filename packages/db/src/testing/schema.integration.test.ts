import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createTestDatabase,
  seedLedgerLeg,
  seedPoolAccount,
  seedUser,
  type TestDatabase,
} from './pglite.js';

/**
 * Schema integration tests, against a real Postgres.
 *
 * These assert what the *database* guarantees, not what application code
 * intends. The distinction matters because every guarantee here is one the
 * application deliberately does not re-check — idempotency is a unique index,
 * not an `if` statement, precisely so two concurrent requests cannot both pass
 * the check and then both insert.
 *
 * Migrations are executed rather than the schema pushed, so a migration that is
 * valid Prisma but invalid SQL fails here rather than in a deploy.
 */
describe('schema integration', () => {
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

  describe('migrations', () => {
    it('applies cleanly from empty', async () => {
      // The whole history, in order, against a blank database — which is what a
      // fresh production deploy does.
      const tables = await test.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
      );

      const names = tables.map((row) => row.tablename);
      for (const expected of [
        'users',
        'wallets',
        'rooms',
        'games',
        'game_players',
        'pool_accounts',
        'transactions',
        'deposits',
        'withdrawals',
        'rewards',
        'leaderboard',
        'match_history',
        'refresh_tokens',
        'audit_logs',
      ]) {
        expect(names, `missing table ${expected}`).toContain(expected);
      }
    });

    it('maps the leaderboard window column away from the reserved word', async () => {
      // `window` is a reserved word in Postgres. This was a real bug, caught
      // only by executing the migration — Prisma validated the schema happily.
      const columns = await test.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'leaderboard'`,
      );

      const names = columns.map((row) => row.column_name);
      expect(names).toContain('window_type');
      expect(names).not.toContain('window');
    });
  });

  describe('ledger idempotency', () => {
    it('rejects a duplicate idempotency key', async () => {
      // The property the whole settlement path depends on. Enforced by a unique
      // index rather than an application check, so two concurrent retries
      // cannot both observe "not yet posted" and both insert.
      const pool = await seedPoolAccount(test, { kind: 'TREASURY', name: 'treasury' });
      const group = crypto.randomUUID();

      await seedLedgerLeg(test, {
        entryGroupId: group,
        poolAccountId: pool,
        direction: 'CREDIT',
        amount: 100n,
        balanceAfter: 100n,
        idempotencyKey: 'settle:game-1',
      });

      const error = await test.expectFailure(
        `INSERT INTO transactions
           (id, entry_group_id, type, direction, status, amount_lamports,
            balance_after_lamports, pool_account_id, idempotency_key)
         VALUES (gen_random_uuid(), $1, 'PAYOUT'::transaction_type, 'CREDIT'::transaction_direction,
                 'POSTED'::transaction_status, 100, 200, $2, 'settle:game-1')`,
        [group, pool],
      );

      expect(error).toMatch(/duplicate key|unique/i);
    });

    it('allows the same amount under different keys', async () => {
      // Two genuinely separate payouts of the same size must both post.
      const pool = await seedPoolAccount(test, { kind: 'TREASURY', name: 'treasury' });

      for (const key of ['payout:a', 'payout:b']) {
        await seedLedgerLeg(test, {
          entryGroupId: crypto.randomUUID(),
          poolAccountId: pool,
          direction: 'CREDIT',
          amount: 100n,
          balanceAfter: 100n,
          idempotencyKey: key,
        });
      }

      // Cast to text rather than trusting the driver's mapping: node-postgres
      // returns `count(*)` as a string to preserve int8 range, PGlite as a
      // number. Asking for text makes the assertion driver-independent.
      const rows = await test.query<{ total: string }>(
        'SELECT count(*)::text AS total FROM transactions',
      );
      expect(rows[0]?.total).toBe('2');
    });
  });

  describe('double-entry invariant', () => {
    it('sums a balanced entry group to zero', async () => {
      const from = await seedPoolAccount(test, { kind: 'TREASURY', name: 'treasury' });
      const to = await seedPoolAccount(test, { kind: 'REWARDS', name: 'rewards' });
      const group = crypto.randomUUID();

      await seedLedgerLeg(test, {
        entryGroupId: group,
        poolAccountId: from,
        direction: 'DEBIT',
        amount: 500n,
        balanceAfter: -500n,
        idempotencyKey: 'transfer:1:debit',
      });
      await seedLedgerLeg(test, {
        entryGroupId: group,
        poolAccountId: to,
        direction: 'CREDIT',
        amount: 500n,
        balanceAfter: 500n,
        idempotencyKey: 'transfer:1:credit',
      });

      // The exact query the reconciler runs, against real SQL rather than a
      // reimplementation of it in JavaScript.
      const rows = await test.query<{ drift: string }>(
        `SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_lamports
                                  ELSE -amount_lamports END), 0)::text AS drift
         FROM transactions WHERE entry_group_id = $1`,
        [group],
      );

      expect(rows[0]?.drift).toBe('0');
    });

    it('surfaces an unbalanced group as non-zero drift', async () => {
      const pool = await seedPoolAccount(test, { kind: 'TREASURY', name: 'treasury' });
      const group = crypto.randomUUID();

      await seedLedgerLeg(test, {
        entryGroupId: group,
        poolAccountId: pool,
        direction: 'CREDIT',
        amount: 500n,
        balanceAfter: 500n,
        idempotencyKey: 'broken:1',
      });

      const rows = await test.query<{ drift: string }>(
        `SELECT SUM(CASE WHEN direction = 'CREDIT' THEN amount_lamports
                         ELSE -amount_lamports END)::text AS drift
         FROM transactions WHERE entry_group_id = $1`,
        [group],
      );

      expect(rows[0]?.drift).toBe('500');
    });

    it('keeps lamport precision past the float boundary', async () => {
      // 2^53 + 1. A column typed as double precision, or a driver that returns
      // JS numbers, silently rounds this — and a rounded ledger is worse than
      // no ledger.
      const pool = await seedPoolAccount(test, { kind: 'TREASURY', name: 'treasury' });
      const huge = 9_007_199_254_740_993n;

      await seedLedgerLeg(test, {
        entryGroupId: crypto.randomUUID(),
        poolAccountId: pool,
        direction: 'CREDIT',
        amount: huge,
        balanceAfter: huge,
        idempotencyKey: 'huge:1',
      });

      const rows = await test.query<{ amount_lamports: bigint }>(
        'SELECT amount_lamports FROM transactions',
      );

      expect(rows[0]?.amount_lamports).toBe(huge);
    });
  });

  describe('referential integrity', () => {
    it('refuses a transaction against a pool account that does not exist', async () => {
      const error = await test.expectFailure(
        `INSERT INTO transactions
           (id, entry_group_id, type, direction, status, amount_lamports,
            balance_after_lamports, pool_account_id, idempotency_key)
         VALUES (gen_random_uuid(), gen_random_uuid(), 'PAYOUT'::transaction_type,
                 'CREDIT'::transaction_direction, 'POSTED'::transaction_status,
                 100, 100, gen_random_uuid(), 'orphan:1')`,
      );

      expect(error).toMatch(/foreign key|violates/i);
    });

    it('refuses to delete a pool account that has ledger entries', async () => {
      // `onDelete: Restrict`. Deleting an account would orphan its history, and
      // the history is the part that has to survive.
      const pool = await seedPoolAccount(test, { kind: 'TREASURY', name: 'treasury' });
      await seedLedgerLeg(test, {
        entryGroupId: crypto.randomUUID(),
        poolAccountId: pool,
        direction: 'CREDIT',
        amount: 1n,
        balanceAfter: 1n,
        idempotencyKey: 'keep:1',
      });

      const error = await test.expectFailure('DELETE FROM pool_accounts WHERE id = $1', [pool]);
      expect(error).toMatch(/foreign key|violates|still referenced/i);
    });

    it('keeps a transaction when its user is deleted', async () => {
      // `onDelete: SetNull`. Financial history must outlive the account — a
      // cascade here would erase the record of money that actually moved.
      const user = await seedUser(test);
      const pool = await seedPoolAccount(test, {
        kind: 'USER_CUSTODY',
        name: `custody:${user}`,
        ownerUserId: user,
      });

      await seedLedgerLeg(test, {
        entryGroupId: crypto.randomUUID(),
        poolAccountId: pool,
        direction: 'CREDIT',
        amount: 100n,
        balanceAfter: 100n,
        idempotencyKey: 'survives:1',
        userId: user,
      });

      await test.query('DELETE FROM users WHERE id = $1', [user]);

      const rows = await test.query<{ user_id: string | null }>('SELECT user_id FROM transactions');

      expect(rows).toHaveLength(1);
      expect(rows[0]?.user_id).toBeNull();
    });
  });

  describe('uniqueness guarantees', () => {
    it('binds one wallet address to one owner', async () => {
      const first = await seedUser(test);
      const second = await seedUser(test);
      const address = 'So11111111111111111111111111111111111111112';

      await test.query(
        `INSERT INTO wallets (id, user_id, address, chain, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'SOLANA'::chain, now())`,
        [first, address],
      );

      // Two users claiming the same wallet would make custody ambiguous.
      const error = await test.expectFailure(
        `INSERT INTO wallets (id, user_id, address, chain, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'SOLANA'::chain, now())`,
        [second, address],
      );

      expect(error).toMatch(/duplicate key|unique/i);
    });

    it('allows one custody account per user and no more', async () => {
      const user = await seedUser(test);
      await seedPoolAccount(test, {
        kind: 'USER_CUSTODY',
        name: `custody:${user}`,
        ownerUserId: user,
      });

      // A second custody account would split a player's balance in two, and
      // every "spendable" calculation reads only one of them.
      const error = await test.expectFailure(
        `INSERT INTO pool_accounts (id, kind, name, owner_user_id, updated_at)
         VALUES (gen_random_uuid(), 'USER_CUSTODY'::pool_account_kind, $1, $2, now())`,
        [`custody:${user}:dup`, user],
      );

      expect(error).toMatch(/duplicate key|unique/i);
    });

    it('allows one game_players row per user per game', async () => {
      // The constraint that makes a retried join idempotent rather than
      // charging a second entry fee.
      const user = await seedUser(test);
      const owner = await seedUser(test);

      const room = await test.query<{ id: string }>(
        `INSERT INTO rooms (id, code, mode, region, status, visibility, owner_id, updated_at)
         VALUES (gen_random_uuid(), 'r1', 'CASUAL'::game_mode, 'US_EAST'::region,
                 'ACTIVE'::room_status, 'PUBLIC'::room_visibility, $1, now())
         RETURNING id`,
        [owner],
      );
      const roomId = room[0]?.id;

      const game = await test.query<{ id: string }>(
        `INSERT INTO games (id, room_id, seed, node_id) VALUES (gen_random_uuid(), $1, 1, 'n1')
         RETURNING id`,
        [roomId],
      );
      const gameId = game[0]?.id;

      await test.query(
        `INSERT INTO game_players (id, game_id, user_id, nickname)
         VALUES (gen_random_uuid(), $1, $2, 'p')`,
        [gameId, user],
      );

      const error = await test.expectFailure(
        `INSERT INTO game_players (id, game_id, user_id, nickname)
         VALUES (gen_random_uuid(), $1, $2, 'p')`,
        [gameId, user],
      );

      expect(error).toMatch(/duplicate key|unique/i);
    });

    it('binds one settlement signature to one game', async () => {
      // Two games claiming the same on-chain signature means one of them was
      // never actually paid.
      const owner = await seedUser(test);
      const room = await test.query<{ id: string }>(
        `INSERT INTO rooms (id, code, mode, region, status, visibility, owner_id, updated_at)
         VALUES (gen_random_uuid(), 'r1', 'CASUAL'::game_mode, 'US_EAST'::region,
                 'ACTIVE'::room_status, 'PUBLIC'::room_visibility, $1, now())
         RETURNING id`,
        [owner],
      );
      const roomId = room[0]?.id;

      await test.query(
        `INSERT INTO games (id, room_id, seed, node_id, settlement_signature)
         VALUES (gen_random_uuid(), $1, 1, 'n1', 'sig-abc')`,
        [roomId],
      );

      const error = await test.expectFailure(
        `INSERT INTO games (id, room_id, seed, node_id, settlement_signature)
         VALUES (gen_random_uuid(), $1, 2, 'n1', 'sig-abc')`,
        [roomId],
      );

      expect(error).toMatch(/duplicate key|unique/i);
    });
  });

  describe('enum coverage', () => {
    it('rejects a status value the application does not define', async () => {
      // Enums rather than free text: a typo'd status would otherwise sit in the
      // database silently failing every filter that looks for the real value.
      const error = await test.expectFailure(
        `INSERT INTO users (id, status, updated_at)
         VALUES (gen_random_uuid(), 'DEFINITELY_NOT_A_STATUS'::user_status, now())`,
      );

      expect(error).toMatch(/invalid input value|does not exist/i);
    });

    it('includes NOT_REQUIRED among settlement statuses', async () => {
      // The value my admin API originally got wrong. Free-to-play matches have
      // nothing to settle, which is different from having settled.
      const rows = await test.query<{ enumlabel: string }>(
        `SELECT enumlabel FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = 'settlement_status' ORDER BY e.enumsortorder`,
      );

      expect(rows.map((r) => r.enumlabel)).toEqual([
        'NOT_REQUIRED',
        'PENDING',
        'SUBMITTED',
        'CONFIRMED',
        'FAILED',
      ]);
    });
  });

  describe('indexes', () => {
    it('indexes the columns the hot queries order by', async () => {
      // Not a performance assertion — an existence one. A missing index here
      // turns a keyset page into a sequential scan, which is invisible on a
      // laptop and fatal at a hundred million rows.
      const rows = await test.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE tablename = 'transactions'`,
      );
      const defs = rows.map((r) => r.indexdef).join('\n');

      expect(defs).toMatch(/user_id.*created_at/s);
      expect(defs).toMatch(/pool_account_id.*created_at/s);
      expect(defs).toMatch(/entry_group_id/);
    });
  });
});
