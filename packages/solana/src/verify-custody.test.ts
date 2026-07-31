import { Keypair, PublicKey, type ParsedTransactionWithMeta } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import { verifyDeposit, verifyWithdrawal } from './verify-custody.js';

const programId = new PublicKey('Arena111111111111111111111111111111111111111');
const pool = Keypair.generate().publicKey;
const treasury = Keypair.generate().publicKey;
const depositor = Keypair.generate().publicKey;
const attacker = Keypair.generate().publicKey;

/** Minimal parsed-transaction fixture with controllable balance deltas. */
function fixture(options: {
  keys: { pubkey: PublicKey; signer: boolean }[];
  pre: number[];
  post: number[];
  err?: unknown;
  invokeProgram?: boolean;
}): ParsedTransactionWithMeta {
  const logs =
    options.invokeProgram === false ? [] : [`Program ${programId.toBase58()} invoke [1]`];

  return {
    slot: 100,
    blockTime: 1_700_000_000,
    transaction: {
      signatures: ['sig'],
      message: {
        accountKeys: options.keys.map((key) => ({
          pubkey: key.pubkey,
          signer: key.signer,
          writable: true,
        })),
        instructions: [],
        recentBlockhash: 'hash',
      },
    },
    meta: {
      err: options.err ?? null,
      fee: 5_000,
      preBalances: options.pre,
      postBalances: options.post,
      innerInstructions: [],
      logMessages: logs,
      preTokenBalances: [],
      postTokenBalances: [],
      rewards: [],
    },
  } as unknown as ParsedTransactionWithMeta;
}

describe('verifyDeposit', () => {
  const keys = [
    { pubkey: depositor, signer: true },
    { pubkey: pool, signer: false },
  ];

  it('accepts a genuine deposit', () => {
    const result = verifyDeposit({
      transaction: fixture({ keys, pre: [10_000_000, 0], post: [8_995_000, 1_000_000] }),
      programId,
      pool,
      depositor,
      expectedLamports: 1_000_000n,
    });

    expect(result.ok).toBe(true);
    expect(result.observedLamports).toBe(1_000_000n);
  });

  it('rejects a transaction that another wallet signed', () => {
    // Without this check, anyone could paste someone else's deposit signature
    // and have it credited to their own account.
    const result = verifyDeposit({
      transaction: fixture({
        keys: [
          { pubkey: attacker, signer: true },
          { pubkey: pool, signer: false },
        ],
        pre: [10_000_000, 0],
        post: [8_995_000, 1_000_000],
      }),
      programId,
      pool,
      depositor,
      expectedLamports: 1_000_000n,
    });

    expect(result.ok).toBe(false);
    expect(result.failure).toBe('signer-mismatch');
  });

  it('rejects a failed transaction', () => {
    const result = verifyDeposit({
      transaction: fixture({
        keys,
        pre: [10_000_000, 0],
        post: [8_995_000, 1_000_000],
        err: { InstructionError: [0, { Custom: 6007 }] },
      }),
      programId,
      pool,
      depositor,
      expectedLamports: 1_000_000n,
    });

    expect(result.ok).toBe(false);
    expect(result.failure).toBe('transaction-failed');
  });

  it('rejects a transfer that never touched the arena program', () => {
    // A plain SystemProgram transfer to the pool would credit the vault but
    // never update the on-chain custody balance.
    const result = verifyDeposit({
      transaction: fixture({
        keys,
        pre: [10_000_000, 0],
        post: [8_995_000, 1_000_000],
        invokeProgram: false,
      }),
      programId,
      pool,
      depositor,
      expectedLamports: 1_000_000n,
    });

    expect(result.ok).toBe(false);
    expect(result.failure).toBe('program-not-invoked');
  });

  it('rejects an underpayment', () => {
    const result = verifyDeposit({
      transaction: fixture({ keys, pre: [10_000_000, 0], post: [9_995_000, 1_000] }),
      programId,
      pool,
      depositor,
      expectedLamports: 1_000_000n,
    });

    expect(result.ok).toBe(false);
    expect(result.failure).toBe('amount-mismatch');
    // The observed figure is still reported, so the operator can see the gap.
    expect(result.observedLamports).toBe(1_000n);
  });

  it('accepts an overpayment and reports what actually arrived', () => {
    const result = verifyDeposit({
      transaction: fixture({ keys, pre: [10_000_000, 0], post: [7_995_000, 2_000_000] }),
      programId,
      pool,
      depositor,
      expectedLamports: 1_000_000n,
    });

    expect(result.ok).toBe(true);
    // The caller credits this, not the requested amount.
    expect(result.observedLamports).toBe(2_000_000n);
  });

  it('rejects a transaction that drained the pool instead of funding it', () => {
    const result = verifyDeposit({
      transaction: fixture({ keys, pre: [10_000_000, 5_000_000], post: [14_000_000, 1_000_000] }),
      programId,
      pool,
      depositor,
      expectedLamports: 1_000_000n,
    });

    expect(result.ok).toBe(false);
    expect(result.failure).toBe('wrong-direction');
  });
});

describe('verifyWithdrawal', () => {
  const keys = [
    { pubkey: depositor, signer: true },
    { pubkey: pool, signer: false },
    { pubkey: treasury, signer: false },
  ];

  it('accepts a withdrawal with the expected fee split', () => {
    // gross 1_000_000, fee 10_000 (1%), net 990_000.
    const result = verifyWithdrawal({
      transaction: fixture({
        keys,
        pre: [1_000_000, 5_000_000, 100_000],
        post: [1_985_000, 4_000_000, 110_000],
      }),
      programId,
      pool,
      treasury,
      recipient: depositor,
      expectedGrossLamports: 1_000_000n,
      expectedFeeLamports: 10_000n,
    });

    expect(result.ok).toBe(true);
    expect(result.debitedFromPool).toBe(1_000_000n);
    expect(result.feeToTreasury).toBe(10_000n);
  });

  it('accepts a zero-fee withdrawal', () => {
    const result = verifyWithdrawal({
      transaction: fixture({
        keys,
        pre: [1_000_000, 5_000_000, 100_000],
        post: [1_995_000, 4_000_000, 100_000],
      }),
      programId,
      pool,
      treasury,
      recipient: depositor,
      expectedGrossLamports: 1_000_000n,
      expectedFeeLamports: 0n,
    });

    expect(result.ok).toBe(true);
  });

  it('rejects a fee that did not reach the treasury', () => {
    const result = verifyWithdrawal({
      transaction: fixture({
        keys,
        pre: [1_000_000, 5_000_000, 100_000],
        post: [1_995_000, 4_000_000, 100_000],
      }),
      programId,
      pool,
      treasury,
      recipient: depositor,
      expectedGrossLamports: 1_000_000n,
      expectedFeeLamports: 10_000n,
    });

    expect(result.ok).toBe(false);
    expect(result.failure).toBe('amount-mismatch');
  });

  it('rejects a pool debit that differs from the recorded gross', () => {
    const result = verifyWithdrawal({
      transaction: fixture({
        keys,
        pre: [1_000_000, 5_000_000, 100_000],
        post: [3_995_000, 2_000_000, 100_000],
      }),
      programId,
      pool,
      treasury,
      recipient: depositor,
      expectedGrossLamports: 1_000_000n,
      expectedFeeLamports: 0n,
    });

    expect(result.ok).toBe(false);
    expect(result.failure).toBe('amount-mismatch');
    expect(result.debitedFromPool).toBe(3_000_000n);
  });

  it('rejects a withdrawal signed by someone other than the recipient', () => {
    const result = verifyWithdrawal({
      transaction: fixture({
        keys: [
          { pubkey: attacker, signer: true },
          { pubkey: pool, signer: false },
          { pubkey: treasury, signer: false },
        ],
        pre: [1_000_000, 5_000_000, 100_000],
        post: [1_995_000, 4_000_000, 100_000],
      }),
      programId,
      pool,
      treasury,
      recipient: depositor,
      expectedGrossLamports: 1_000_000n,
      expectedFeeLamports: 0n,
    });

    expect(result.ok).toBe(false);
    expect(result.failure).toBe('signer-mismatch');
  });

  it('does not confuse a deposit for a withdrawal', () => {
    const result = verifyWithdrawal({
      transaction: fixture({
        keys,
        pre: [10_000_000, 0, 0],
        post: [8_995_000, 1_000_000, 0],
      }),
      programId,
      pool,
      treasury,
      recipient: depositor,
      expectedGrossLamports: 1_000_000n,
      expectedFeeLamports: 0n,
    });

    expect(result.ok).toBe(false);
    expect(result.failure).toBe('wrong-direction');
  });
});
