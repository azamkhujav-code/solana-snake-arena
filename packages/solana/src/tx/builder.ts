import {
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type PublicKey,
  type Blockhash,
  type Connection,
  type Signer,
  type TransactionInstruction,
} from '@solana/web3.js';

import { toServiceError } from '../errors.js';

export interface BuildOptions {
  payer: PublicKey;
  instructions: TransactionInstruction[];
  /**
   * Compute-unit ceiling. Setting it explicitly matters: the 200k default is
   * both wasteful for simple transfers and too low for a multi-winner payout.
   */
  computeUnitLimit?: number;
  /**
   * Priority fee in micro-lamports per compute unit. Under congestion a
   * transaction with no priority fee can sit unconfirmed indefinitely.
   */
  priorityFeeMicroLamports?: number;
  lookupTables?: AddressLookupTableAccount[];
  recentBlockhash?: Blockhash;
}

/**
 * Builds versioned (v0) transactions.
 *
 * v0 rather than legacy because payouts touch many accounts and only v0
 * supports address lookup tables, which is the escape hatch if a distribution
 * ever outgrows the per-transaction account limit.
 */
export class TransactionBuilder {
  private readonly instructions: TransactionInstruction[] = [];
  private computeUnitLimit: number | undefined;
  private priorityFeeMicroLamports: number | undefined;

  constructor(private readonly payer: PublicKey) {}

  add(...instructions: TransactionInstruction[]): this {
    this.instructions.push(...instructions);
    return this;
  }

  withComputeUnitLimit(units: number): this {
    this.computeUnitLimit = units;
    return this;
  }

  withPriorityFee(microLamportsPerUnit: number): this {
    this.priorityFeeMicroLamports = microLamportsPerUnit;
    return this;
  }

  /**
   * Compute-budget instructions must come first in the message, so they are
   * prepended here rather than left to call-site ordering.
   */
  private assemble(): TransactionInstruction[] {
    const prefix: TransactionInstruction[] = [];

    if (this.computeUnitLimit !== undefined) {
      prefix.push(ComputeBudgetProgram.setComputeUnitLimit({ units: this.computeUnitLimit }));
    }
    if (this.priorityFeeMicroLamports !== undefined) {
      prefix.push(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: this.priorityFeeMicroLamports,
        }),
      );
    }

    return [...prefix, ...this.instructions];
  }

  /**
   * Compiles the transaction.
   *
   * The blockhash is fetched at build time and its validity window is short
   * (~60s), so build immediately before sending — not at the top of a long
   * request handler.
   */
  async build(
    connection: Connection,
    options: { lookupTables?: AddressLookupTableAccount[] } = {},
  ): Promise<{
    transaction: VersionedTransaction;
    blockhash: string;
    lastValidBlockHeight: number;
  }> {
    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

      const message = new TransactionMessage({
        payerKey: this.payer,
        recentBlockhash: blockhash,
        instructions: this.assemble(),
      }).compileToV0Message(options.lookupTables ?? []);

      return {
        transaction: new VersionedTransaction(message),
        blockhash,
        lastValidBlockHeight,
      };
    } catch (error) {
      throw toServiceError(error);
    }
  }

  /**
   * Simulates before sending.
   *
   * Worth doing for anything that moves money: simulation surfaces the program
   * error and its logs without paying a fee or consuming a blockhash.
   */
  async simulate(
    connection: Connection,
    signers: Signer[] = [],
  ): Promise<{ unitsConsumed: number | undefined; logs: string[] }> {
    const { transaction } = await this.build(connection);
    if (signers.length > 0) transaction.sign(signers);

    const result = await connection.simulateTransaction(transaction, {
      sigVerify: false,
      replaceRecentBlockhash: true,
    });

    if (result.value.err) {
      throw toServiceError(result.value.err, result.value.logs ?? []);
    }

    return {
      unitsConsumed: result.value.unitsConsumed,
      logs: result.value.logs ?? [],
    };
  }

  get instructionCount(): number {
    return this.instructions.length;
  }
}
