import type { ParsedTransactionWithMeta, PublicKey } from '@solana/web3.js';

import { parseBalanceChanges } from './tx/parse.js';

/**
 * On-chain verification of custody movements.
 *
 * The rule these functions exist to enforce: **never credit a database balance
 * from anything the client told us.** A client supplies a signature and an
 * amount; the signature could be lifted from any real transaction and the
 * amount is simply a number they typed. Both are re-derived here from the
 * chain's own accounting before a single row is written.
 *
 * Balance deltas are used rather than parsed instructions because the program
 * moves lamports inside CPIs, which never appear as top-level System Program
 * transfers.
 */

export type VerificationFailure =
  | 'not-found'
  | 'transaction-failed'
  | 'program-not-invoked'
  | 'signer-mismatch'
  | 'amount-mismatch'
  | 'wrong-direction';

export interface VerificationResult {
  ok: boolean;
  failure: VerificationFailure | null;
  /** Lamports actually moved, derived from pre/post balances. */
  observedLamports: bigint;
  slot: number;
  blockTime: number | null;
}

function failure(
  reason: VerificationFailure,
  observedLamports = 0n,
  slot = 0,
  blockTime: number | null = null,
): VerificationResult {
  return { ok: false, failure: reason, observedLamports, slot, blockTime };
}

/** True when the transaction invoked `programId` at any nesting depth. */
export function invokedProgram(
  transaction: ParsedTransactionWithMeta,
  programId: PublicKey,
): boolean {
  const target = programId.toBase58();

  for (const instruction of transaction.transaction.message.instructions) {
    if (instruction.programId.toBase58() === target) return true;
  }

  // Inner instructions catch the CPI case.
  for (const inner of transaction.meta?.innerInstructions ?? []) {
    for (const instruction of inner.instructions) {
      if (instruction.programId.toBase58() === target) return true;
    }
  }

  // Logs are the last resort: some RPCs omit inner instructions for older slots.
  return (transaction.meta?.logMessages ?? []).some((line) =>
    line.startsWith(`Program ${target} invoke`),
  );
}

/** True when `wallet` signed the transaction. */
export function isSigner(transaction: ParsedTransactionWithMeta, wallet: PublicKey): boolean {
  const target = wallet.toBase58();
  return transaction.transaction.message.accountKeys.some(
    (key) => key.signer && key.pubkey.toBase58() === target,
  );
}

export interface VerifyDepositParams {
  transaction: ParsedTransactionWithMeta;
  programId: PublicKey;
  /** Shared custody vault. */
  pool: PublicKey;
  /** Wallet the deposit is being credited to. */
  depositor: PublicKey;
  /** Minimum the pool must have gained for this to count. */
  expectedLamports: bigint;
}

/**
 * Confirms a deposit really happened, and for the claimed wallet.
 *
 * The depositor check is the one that is easy to omit and expensive to miss:
 * without it, any user could paste someone else's deposit signature and have it
 * credited to their own account.
 */
export function verifyDeposit(params: VerifyDepositParams): VerificationResult {
  const { transaction, programId, pool, depositor, expectedLamports } = params;

  if (transaction.meta?.err) return failure('transaction-failed');
  if (!invokedProgram(transaction, programId)) return failure('program-not-invoked');
  if (!isSigner(transaction, depositor)) return failure('signer-mismatch');

  const changes = parseBalanceChanges(transaction);
  const credited = changes.get(pool.toBase58()) ?? 0n;

  const base = {
    observedLamports: credited,
    slot: transaction.slot,
    blockTime: transaction.blockTime ?? null,
  };

  if (credited <= 0n) {
    return { ok: false, failure: 'wrong-direction', ...base };
  }
  if (credited < expectedLamports) {
    return { ok: false, failure: 'amount-mismatch', ...base };
  }

  return { ok: true, failure: null, ...base };
}

export interface VerifyWithdrawalParams {
  transaction: ParsedTransactionWithMeta;
  programId: PublicKey;
  pool: PublicKey;
  treasury: PublicKey;
  /** Wallet receiving the net payout. */
  recipient: PublicKey;
  /** Gross amount debited from the custody balance. */
  expectedGrossLamports: bigint;
  expectedFeeLamports: bigint;
}

export interface WithdrawalVerificationResult extends VerificationResult {
  /** Lamports that left the pool. Positive. */
  debitedFromPool: bigint;
  feeToTreasury: bigint;
}

/**
 * Confirms a withdrawal drained the pool by the gross amount and split it
 * correctly between the recipient and the treasury.
 *
 * The recipient's own delta is deliberately *not* compared to the net amount:
 * they also paid the network fee out of the same account, so their balance
 * change is `net - txFee`. Asserting on the pool debit and the treasury credit
 * is exact and avoids that off-by-a-fee false alarm.
 */
export function verifyWithdrawal(params: VerifyWithdrawalParams): WithdrawalVerificationResult {
  const { transaction, programId, pool, treasury, recipient } = params;

  const empty = { debitedFromPool: 0n, feeToTreasury: 0n };

  if (transaction.meta?.err) return { ...failure('transaction-failed'), ...empty };
  if (!invokedProgram(transaction, programId)) {
    return { ...failure('program-not-invoked'), ...empty };
  }
  if (!isSigner(transaction, recipient)) return { ...failure('signer-mismatch'), ...empty };

  const changes = parseBalanceChanges(transaction);
  const poolDelta = changes.get(pool.toBase58()) ?? 0n;
  const treasuryDelta = changes.get(treasury.toBase58()) ?? 0n;

  const debitedFromPool = poolDelta < 0n ? -poolDelta : 0n;
  const base = {
    observedLamports: debitedFromPool,
    slot: transaction.slot,
    blockTime: transaction.blockTime ?? null,
    debitedFromPool,
    feeToTreasury: treasuryDelta > 0n ? treasuryDelta : 0n,
  };

  if (poolDelta >= 0n) {
    return { ok: false, failure: 'wrong-direction', ...base };
  }
  if (debitedFromPool !== params.expectedGrossLamports) {
    return { ok: false, failure: 'amount-mismatch', ...base };
  }
  if (base.feeToTreasury !== params.expectedFeeLamports) {
    return { ok: false, failure: 'amount-mismatch', ...base };
  }

  return { ok: true, failure: null, ...base };
}
