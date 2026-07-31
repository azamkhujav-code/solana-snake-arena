import type {
  Commitment,
  Connection,
  SignatureStatus,
  VersionedTransaction,
} from '@solana/web3.js';

import { ConfirmationTimeoutError, toServiceError } from '../errors.js';
import { withRetry } from './retry.js';

export interface SendAndConfirmOptions {
  commitment?: Commitment;
  /** Overall confirmation deadline. */
  timeoutMs?: number;
  /** How often to poll for a signature status. */
  pollIntervalMs?: number;
  /**
   * Re-broadcast interval. A transaction can be dropped by the leader without
   * any error being returned, so it is resent until the blockhash expires.
   */
  rebroadcastIntervalMs?: number;
  maxSendAttempts?: number;
  onStatus?: (status: SignatureStatus | null, elapsedMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends a signed transaction and waits for confirmation.
 *
 * Polls signature status rather than using `confirmTransaction`'s websocket
 * subscription: the subscription silently never fires if the WS connection
 * drops, which presents as a hung request rather than an error. Polling is
 * chattier but observable.
 *
 * Re-broadcasts periodically because a transaction dropped by the leader
 * produces no error at all — it simply never confirms.
 */
export async function sendAndConfirm(
  connection: Connection,
  transaction: VersionedTransaction,
  blockhashInfo: { blockhash: string; lastValidBlockHeight: number },
  options: SendAndConfirmOptions = {},
): Promise<{ signature: string; slot: number }> {
  const commitment = options.commitment ?? 'confirmed';
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const rebroadcastIntervalMs = options.rebroadcastIntervalMs ?? 3_000;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;

  const raw = transaction.serialize();

  const signature = await withRetry(
    async () =>
      connection.sendRawTransaction(raw, {
        skipPreflight: false,
        preflightCommitment: commitment,
        // Retries are handled here so failures stay visible.
        maxRetries: 0,
      }),
    { maxAttempts: options.maxSendAttempts ?? 3 },
  );

  const startedAt = now();
  let lastBroadcast = startedAt;

  for (;;) {
    const elapsed = now() - startedAt;
    if (elapsed >= timeoutMs) {
      throw new ConfirmationTimeoutError(signature, timeoutMs);
    }

    let status: SignatureStatus | null = null;
    try {
      const response = await connection.getSignatureStatuses([signature]);
      status = response.value[0] ?? null;
    } catch {
      // A status lookup failure is not itself fatal; keep polling until the
      // deadline or the blockhash expiry decides the outcome.
    }

    options.onStatus?.(status, elapsed);

    if (status) {
      if (status.err) {
        throw toServiceError(status.err);
      }
      const reached =
        commitment === 'finalized'
          ? status.confirmationStatus === 'finalized'
          : status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized';

      if (reached) {
        return { signature, slot: status.slot };
      }
    }

    // Once the block height passes the blockhash's validity window the
    // transaction can never land, so waiting out the full timeout is pointless.
    try {
      const blockHeight = await connection.getBlockHeight(commitment);
      if (blockHeight > blockhashInfo.lastValidBlockHeight) {
        throw new ConfirmationTimeoutError(signature, elapsed);
      }
    } catch (error) {
      if (error instanceof ConfirmationTimeoutError) throw error;
    }

    if (now() - lastBroadcast >= rebroadcastIntervalMs) {
      lastBroadcast = now();
      try {
        await connection.sendRawTransaction(raw, {
          skipPreflight: true,
          maxRetries: 0,
        });
      } catch {
        // A duplicate-broadcast rejection is expected and harmless.
      }
    }

    await sleep(pollIntervalMs);
  }
}
