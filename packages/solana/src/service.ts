import {
  type Keypair,
  PublicKey,
  type Commitment,
  type Connection,
  type Finality,
  type ParsedTransactionWithMeta,
  type TransactionInstruction,
} from '@solana/web3.js';

import { RpcPool, type RpcEndpoint } from './connection.js';
import { SolanaServiceError, toServiceError } from './errors.js';
import {
  createCancelRoomInstruction,
  createClaimRefundInstruction,
  createCloseRoomInstruction,
  createDistributeWinningsInstruction,
  createEnterRoomInstruction,
  createInitializeInstruction,
  createRoomInstruction,
  createSettleToWinnerInstruction,
  createStartRoomInstruction,
  createUnlockPrizeInstruction,
  createWithdrawTreasuryInstruction,
  type WinnerPayout,
} from './instructions.js';
import { findPoolPda, findRoomVaultPda, findTreasuryPda, normalizeRoomId } from './pda.js';
import { TransactionBuilder } from './tx/builder.js';
import { sendAndConfirm } from './tx/confirm.js';
import {
  summarizeTransaction,
  verifyIncomingTransfer,
  type ParsedTransactionSummary,
} from './tx/parse.js';
import { withRetry } from './tx/retry.js';

export interface ArenaServiceOptions {
  programId: string;
  endpoints: readonly RpcEndpoint[];
  commitment?: Commitment;
  /**
   * Hot key that signs room creation and settlement. Held only by the backend.
   * Deliberately distinct from the admin key, so a compromise here cannot move
   * treasury funds.
   */
  settlementAuthority?: Keypair;
  /** Default priority fee. Under congestion, zero-fee transactions can stall. */
  priorityFeeMicroLamports?: number;
  computeUnitLimit?: number;
  logger?: {
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
  };
}

export interface SendResult {
  signature: string;
  slot: number;
}

/**
 * Backend Solana service.
 *
 * Owns RPC access, transaction assembly, retry and confirmation for every
 * server-initiated on-chain action. Player-signed actions (deposit, withdraw,
 * join, lock) are built here but signed in the browser — this class never holds
 * a player key.
 */
export class ArenaService {
  readonly programId: PublicKey;
  private readonly rpc: RpcPool;
  private readonly commitment: Commitment;
  private readonly settlementAuthority: Keypair | undefined;
  private readonly priorityFee: number;
  private readonly computeUnitLimit: number;
  private readonly logger: ArenaServiceOptions['logger'];

  constructor(options: ArenaServiceOptions) {
    this.programId = new PublicKey(options.programId);
    this.commitment = options.commitment ?? 'confirmed';
    this.settlementAuthority = options.settlementAuthority;
    this.priorityFee = options.priorityFeeMicroLamports ?? 1_000;
    this.computeUnitLimit = options.computeUnitLimit ?? 400_000;
    this.logger = options.logger;

    this.rpc = new RpcPool({
      endpoints: options.endpoints,
      commitment: this.commitment,
      ...(options.logger
        ? {
            onFailover: (from, to, error) =>
              options.logger?.warn({ from, to, err: error }, 'rpc failover'),
          }
        : {}),
    });
  }

  get connection(): Connection {
    return this.rpc.current;
  }

  /**
   * Whether this instance can sign on-chain writes.
   *
   * Lets a caller *choose* a path rather than discover the answer by catching
   * an exception. Creating a match escrow, for example, is meaningful either
   * way — the vault address is derivable without a key — so aborting a whole
   * match cycle because the chain leg is unavailable would be the wrong call.
   * Reading this first turns that into a branch instead of a failure.
   */
  get canSignOnChain(): boolean {
    return this.settlementAuthority !== undefined;
  }

  private requireSettlementAuthority(): Keypair {
    if (!this.settlementAuthority) {
      throw new SolanaServiceError(
        'This operation requires a settlement authority keypair, which was not configured',
      );
    }
    return this.settlementAuthority;
  }

  // -------------------------------------------------------------------------
  // Core send path
  // -------------------------------------------------------------------------

  /**
   * Builds, signs, sends and confirms — with a fresh blockhash on every retry.
   *
   * Rebuilding rather than resending the same bytes is the important detail: a
   * transaction that failed because its blockhash expired will fail identically
   * forever if resent unchanged.
   */
  async sendSigned(
    instructions: TransactionInstruction[],
    signers: Keypair[],
    options: { computeUnitLimit?: number; priorityFeeMicroLamports?: number } = {},
  ): Promise<SendResult> {
    const payer = signers[0];
    if (!payer) {
      throw new SolanaServiceError('At least one signer is required to pay fees');
    }

    return withRetry(
      async (attempt) => {
        this.logger?.info({ attempt, instructions: instructions.length }, 'sending transaction');

        return this.rpc.withFailover(async (connection) => {
          const builder = new TransactionBuilder(payer.publicKey)
            .add(...instructions)
            .withComputeUnitLimit(options.computeUnitLimit ?? this.computeUnitLimit)
            .withPriorityFee(options.priorityFeeMicroLamports ?? this.priorityFee);

          const { transaction, blockhash, lastValidBlockHeight } = await builder.build(connection);
          transaction.sign(signers);

          return sendAndConfirm(
            connection,
            transaction,
            { blockhash, lastValidBlockHeight },
            { commitment: this.commitment },
          );
        });
      },
      {
        maxAttempts: 4,
        onRetry: (attempt, delayMs, error) =>
          this.logger?.warn({ attempt, delayMs, err: error }, 'retrying transaction'),
      },
    );
  }

  /**
   * Simulates without sending. Run this before any settlement — it surfaces the
   * program error and logs without spending a fee or a blockhash.
   */
  async simulate(instructions: TransactionInstruction[], payer: PublicKey): Promise<string[]> {
    return this.rpc.withFailover(async (connection) => {
      const builder = new TransactionBuilder(payer)
        .add(...instructions)
        .withComputeUnitLimit(this.computeUnitLimit);
      const { logs } = await builder.simulate(connection);
      return logs;
    });
  }

  // -------------------------------------------------------------------------
  // Pool / program setup
  // -------------------------------------------------------------------------

  /** Creates the config PDA and funds the pool and treasury vaults. */
  async initializeProgram(params: {
    admin: Keypair;
    settlementAuthority: PublicKey;
    /** Wallet the platform fee is paid to. Defaults to the admin. */
    feeDestination?: PublicKey;
    feeBps: number;
    withdrawalFeeBps?: number;
  }): Promise<SendResult> {
    const instruction = createInitializeInstruction({
      programId: this.programId,
      admin: params.admin.publicKey,
      settlementAuthority: params.settlementAuthority,
      feeDestination: params.feeDestination ?? params.admin.publicKey,
      feeBps: params.feeBps,
      withdrawalFeeBps: params.withdrawalFeeBps ?? 0,
    });
    return this.sendSigned([instruction], [params.admin]);
  }

  /** Addresses of the singleton vaults. */
  getVaultAddresses(): { pool: PublicKey; treasury: PublicKey } {
    const [pool] = findPoolPda(this.programId);
    const [treasury] = findTreasuryPda(this.programId);
    return { pool, treasury };
  }

  /**
   * Builds the player-signed entry transaction.
   *
   * Returned as an instruction rather than sent, because only the player can
   * sign it — the backend never holds a player key. The web client wraps this
   * in a transaction and hands it to the wallet.
   */
  buildEnterRoomInstruction(params: { player: PublicKey; roomId: Uint8Array }) {
    return createEnterRoomInstruction({
      programId: this.programId,
      player: params.player,
      roomId: params.roomId,
    });
  }

  /**
   * Pays the last surviving player directly from the match vault.
   *
   * Signed by the settlement authority, so this one the backend does send.
   */
  async settleToWinner(params: {
    roomId: Uint8Array;
    winner: PublicKey;
    feeDestination: PublicKey;
  }): Promise<SendResult> {
    const authority = this.requireSettlementAuthority();
    return this.sendSigned(
      [
        createSettleToWinnerInstruction({
          programId: this.programId,
          settlementAuthority: authority.publicKey,
          feeDestination: params.feeDestination,
          winner: params.winner,
          roomId: params.roomId,
        }),
      ],
      [authority],
    );
  }

  /** Escrow vault address for a room. */
  getRoomVaultAddress(roomId: Uint8Array): PublicKey {
    const [vault] = findRoomVaultPda(this.programId, normalizeRoomId(roomId));
    return vault;
  }

  async getVaultBalances(): Promise<{ pool: bigint; treasury: bigint }> {
    const { pool, treasury } = this.getVaultAddresses();
    return this.rpc.withFailover(async (connection) => {
      const [poolBalance, treasuryBalance] = await Promise.all([
        connection.getBalance(pool, this.commitment),
        connection.getBalance(treasury, this.commitment),
      ]);
      return { pool: BigInt(poolBalance), treasury: BigInt(treasuryBalance) };
    });
  }

  // -------------------------------------------------------------------------
  // Deposits — verified from chain, never trusted from the client
  // -------------------------------------------------------------------------

  /**
   * Confirms that a claimed deposit actually credited the pool vault.
   *
   * The client supplies a signature; that alone proves nothing, since any real
   * signature could be replayed from another transaction. The destination and
   * amount are re-derived from the chain's own pre/post balances before any
   * custody balance is credited off-chain.
   */
  async verifyDeposit(params: {
    signature: string;
    expectedLamports: bigint;
  }): Promise<{ ok: boolean; credited: bigint; summary: ParsedTransactionSummary | null }> {
    const { pool } = this.getVaultAddresses();

    const parsed = await this.getParsedTransaction(params.signature);
    if (!parsed) return { ok: false, credited: 0n, summary: null };

    const summary = summarizeTransaction(params.signature, parsed);
    const { ok, credited } = verifyIncomingTransfer(parsed, pool, params.expectedLamports);

    return { ok: ok && summary.success, credited, summary };
  }

  async getParsedTransaction(signature: string): Promise<ParsedTransactionWithMeta | null> {
    // History lookups accept only `confirmed` or `finalized`; anything looser
    // has no committed transaction to return.
    const finality: Finality = this.commitment === 'finalized' ? 'finalized' : 'confirmed';

    return this.rpc.withFailover(async (connection) =>
      connection.getParsedTransaction(signature, {
        commitment: finality,
        maxSupportedTransactionVersion: 0,
      }),
    );
  }

  /** Fetches and normalises a transaction for the reconciler. */
  async getTransactionSummary(signature: string): Promise<ParsedTransactionSummary | null> {
    const parsed = await this.getParsedTransaction(signature);
    return parsed ? summarizeTransaction(signature, parsed) : null;
  }

  // -------------------------------------------------------------------------
  // Room lifecycle (settlement authority)
  // -------------------------------------------------------------------------

  async createRoom(params: {
    roomId: Uint8Array;
    entryFeeLamports: bigint;
    maxPlayers: number;
  }): Promise<SendResult> {
    const authority = this.requireSettlementAuthority();
    const instruction = createRoomInstruction({
      programId: this.programId,
      settlementAuthority: authority.publicKey,
      roomId: params.roomId,
      entryFeeLamports: params.entryFeeLamports,
      maxPlayers: params.maxPlayers,
    });
    return this.sendSigned([instruction], [authority]);
  }

  async startRoom(roomId: Uint8Array): Promise<SendResult> {
    const authority = this.requireSettlementAuthority();
    return this.sendSigned(
      [
        createStartRoomInstruction({
          programId: this.programId,
          settlementAuthority: authority.publicKey,
          roomId,
        }),
      ],
      [authority],
    );
  }

  /**
   * Reclaims a finished room's rent deposits.
   *
   * The authority signs only because somebody has to pay the transaction fee —
   * the instruction needs no signature of its own, since the lamports return to
   * the authority named in config whoever sends it. Worth about 0.0027 SOL a
   * match, which is otherwise gone for good.
   */
  async closeRoom(roomId: Uint8Array): Promise<SendResult> {
    const authority = this.requireSettlementAuthority();
    return this.sendSigned(
      [
        createCloseRoomInstruction({
          programId: this.programId,
          settlementAuthority: authority.publicKey,
          roomId,
        }),
      ],
      [authority],
    );
  }

  async unlockPrize(roomId: Uint8Array): Promise<SendResult> {
    const authority = this.requireSettlementAuthority();
    return this.sendSigned(
      [
        createUnlockPrizeInstruction({
          programId: this.programId,
          settlementAuthority: authority.publicKey,
          roomId,
        }),
      ],
      [authority],
    );
  }

  /**
   * Pays the winners.
   *
   * Simulated first: a payout table that does not sum to the unlocked prize
   * pool is rejected on-chain, and finding that out through simulation costs
   * nothing while finding it out through a failed send costs a fee and a
   * confusing operator alert.
   */
  async distributeWinnings(params: {
    roomId: Uint8Array;
    winners: readonly WinnerPayout[];
    skipSimulation?: boolean;
  }): Promise<SendResult> {
    const authority = this.requireSettlementAuthority();

    const instruction = createDistributeWinningsInstruction({
      programId: this.programId,
      settlementAuthority: authority.publicKey,
      roomId: params.roomId,
      winners: params.winners,
    });

    if (!params.skipSimulation) {
      try {
        await this.simulate([instruction], authority.publicKey);
      } catch (error) {
        this.logger?.error({ err: error }, 'payout simulation failed; not sending');
        throw toServiceError(error);
      }
    }

    return this.sendSigned([instruction], [authority]);
  }

  async cancelRoom(roomId: Uint8Array): Promise<SendResult> {
    const authority = this.requireSettlementAuthority();
    return this.sendSigned(
      [
        createCancelRoomInstruction({
          programId: this.programId,
          signer: authority.publicKey,
          roomId,
        }),
      ],
      [authority],
    );
  }

  /** Cranks a refund on a player's behalf; they never need SOL for fees. */
  async claimRefundFor(params: { roomId: Uint8Array; player: PublicKey }): Promise<SendResult> {
    const authority = this.requireSettlementAuthority();
    const instruction = createClaimRefundInstruction({
      programId: this.programId,
      player: params.player,
      claimant: authority.publicKey,
      roomId: params.roomId,
    });
    return this.sendSigned([instruction], [authority]);
  }

  // -------------------------------------------------------------------------
  // Treasury (admin)
  // -------------------------------------------------------------------------

  async withdrawTreasury(params: {
    admin: Keypair;
    destination: PublicKey;
    lamports: bigint;
  }): Promise<SendResult> {
    const instruction = createWithdrawTreasuryInstruction({
      programId: this.programId,
      admin: params.admin.publicKey,
      destination: params.destination,
      lamports: params.lamports,
    });
    return this.sendSigned([instruction], [params.admin]);
  }
}
