import { PGlite } from '@electric-sql/pglite';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A real Postgres, in-process, for integration tests.
 *
 * PGlite is Postgres compiled to WASM — the same query planner, the same type
 * system, the same constraint enforcement. That matters more than it sounds:
 * the interesting properties of this schema are things only a real database
 * checks. A mock cannot tell you that `window` is a reserved word, that a
 * partial unique index rejects the second primary wallet, or that a `bigint`
 * survives 9,007,199,254,740,993 intact. Every one of those has been a real bug
 * in this repo.
 *
 * Migrations are executed rather than the schema being pushed, so what the test
 * runs against is exactly what production will get — including any migration
 * that is valid Prisma but invalid SQL.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '../../prisma/migrations');

/** Reads migrations in lexical order, which is the order Prisma applies them. */
export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });

  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const statements: string[] = [];
  for (const name of directories) {
    statements.push(await readFile(join(dir, name, 'migration.sql'), 'utf8'));
  }

  return statements;
}

export interface TestDatabase {
  db: PGlite;
  /** Runs SQL and returns typed rows. */
  query: <T>(sql: string, params?: unknown[]) => Promise<T[]>;
  /** Runs SQL expecting it to fail, returning the error message. */
  expectFailure: (sql: string, params?: unknown[]) => Promise<string>;
  /** Empties every table without re-running migrations. */
  truncate: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Creates a database with the full migration history applied.
 *
 * Deliberately not shared between test files — each gets its own instance so
 * one file's fixtures cannot leak into another's assertions. Startup is a few
 * hundred milliseconds, which is worth paying for that isolation.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const db = await PGlite.create();

  for (const migration of await loadMigrations()) {
    await db.exec(migration);
  }

  const query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    const result = await db.query<T>(sql, params);
    return result.rows;
  };

  return {
    db,
    query,

    async expectFailure(sql: string, params: unknown[] = []): Promise<string> {
      try {
        await db.query(sql, params);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      // Returning a sentinel rather than throwing keeps the assertion in the
      // test, where the failure message can name what was expected to fail.
      throw new Error(`Expected this to fail but it succeeded:\n${sql}`);
    },

    async truncate(): Promise<void> {
      const tables = await query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
      );
      if (tables.length === 0) return;

      // One statement with CASCADE: truncating individually would fail on
      // foreign keys unless the order were exactly right, and that order
      // changes every time the schema does.
      await db.exec(
        `TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`,
      );
    },

    async close(): Promise<void> {
      await db.close();
    },
  };
}

/* ---- Fixtures ---------------------------------------------------------- */

/**
 * Inserts a user and returns its id.
 *
 * Raw SQL rather than Prisma throughout these helpers: the point of this
 * harness is to test what the *database* enforces, and going through an ORM
 * that pre-validates would hide exactly the constraint violations being
 * checked.
 */
export async function seedUser(
  test: TestDatabase,
  overrides: { username?: string; role?: string; status?: string } = {},
): Promise<string> {
  const rows = await test.query<{ id: string }>(
    `INSERT INTO users (id, username, role, status, updated_at)
     VALUES (gen_random_uuid(), $1, $2::user_role, $3::user_status, now())
     RETURNING id`,
    [overrides.username ?? null, overrides.role ?? 'PLAYER', overrides.status ?? 'ACTIVE'],
  );

  const id = rows[0]?.id;
  if (!id) throw new Error('seedUser inserted no row');
  return id;
}

export async function seedPoolAccount(
  test: TestDatabase,
  params: { kind: string; name: string; balance?: bigint; ownerUserId?: string | null },
): Promise<string> {
  const rows = await test.query<{ id: string }>(
    `INSERT INTO pool_accounts (id, kind, name, owner_user_id, balance_lamports, updated_at)
     VALUES (gen_random_uuid(), $1::pool_account_kind, $2, $3, $4, now())
     RETURNING id`,
    [params.kind, params.name, params.ownerUserId ?? null, (params.balance ?? 0n).toString()],
  );

  const id = rows[0]?.id;
  if (!id) throw new Error('seedPoolAccount inserted no row');
  return id;
}

export interface LedgerLegInput {
  entryGroupId: string;
  poolAccountId: string;
  direction: 'CREDIT' | 'DEBIT';
  amount: bigint;
  balanceAfter: bigint;
  idempotencyKey: string;
  type?: string;
  userId?: string | null;
}

export async function seedLedgerLeg(test: TestDatabase, leg: LedgerLegInput): Promise<void> {
  await test.query(
    `INSERT INTO transactions
       (id, entry_group_id, type, direction, status, amount_lamports,
        balance_after_lamports, user_id, pool_account_id, idempotency_key)
     VALUES (gen_random_uuid(), $1, $2::transaction_type, $3::transaction_direction,
             'POSTED'::transaction_status, $4, $5, $6, $7, $8)`,
    [
      leg.entryGroupId,
      leg.type ?? 'TRANSFER',
      leg.direction,
      leg.amount.toString(),
      leg.balanceAfter.toString(),
      leg.userId ?? null,
      leg.poolAccountId,
      leg.idempotencyKey,
    ],
  );
}
