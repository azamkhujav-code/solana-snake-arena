-- Adds the EXTERNAL counter-account kind.
--
-- Double-entry requires both legs of every movement to exist inside the ledger.
-- Without a counter-account, a deposit would have only a credit and a
-- withdrawal only a debit, and the "all legs sum to zero" invariant that makes
-- the books provable would not hold.
--
-- Postgres 12+ permits ADD VALUE inside a transaction provided the new value is
-- not *used* in the same transaction. The seed inserts the row separately.
ALTER TYPE "pool_account_kind" ADD VALUE IF NOT EXISTS 'EXTERNAL';
