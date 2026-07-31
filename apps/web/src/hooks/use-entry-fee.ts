'use client';

import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { ComputeBudgetProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { useCallback, useEffect, useRef, useState } from 'react';

import { buildEnterRoomInstruction, waitForRoomOnChain } from '@/lib/arena-program';
import type { LobbySummary } from '@/lib/lobby-state';

export type EntryFeeStatus =
  | 'idle'
  /** Waiting for the backend to open the room this fee is paid into. */
  | 'preparing'
  | 'awaiting-signature'
  | 'sending'
  | 'paid'
  | 'failed';

/**
 * Pays the entry fee when the room is about to start.
 *
 * This is the step the money model was missing. Joining checks the wallet can
 * afford the room and takes nothing; the fee is collected here, once enough
 * players have queued that the match is actually going to happen. A room that
 * never fills therefore costs nobody anything, and there is no refund path to
 * get wrong — which is where two earlier money bugs lived.
 *
 * The transfer goes straight from the player's wallet into *this match's*
 * vault, under their own signature. Nothing custodial sits in between, so at no
 * point does the platform hold money it would have to give back.
 *
 * Fires on the transition into `countdown`, guarded by a ref: `enter_room`
 * creates a per-player account, so a second attempt fails on chain rather than
 * paying twice — but it would still throw a confusing error at the player, and
 * a poll every two seconds would try it repeatedly.
 */
export function useEntryFee(
  lobby: LobbySummary | null,
  onPaid?: () => void,
): {
  status: EntryFeeStatus;
  error: string | null;
  retry: () => void;
} {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();

  const [status, setStatus] = useState<EntryFeeStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  // Keyed by game, so the next match asks again but this one never twice.
  const paidFor = useRef<string | null>(null);

  const entryFee = lobby ? BigInt(lobby.entryFeeLamports) : 0n;
  const gameId = lobby?.gameId ?? null;
  const counting = lobby?.status === 'countdown';

  const pay = useCallback(
    async (game: string) => {
      if (!publicKey) {
        setError('Connect a wallet to pay the entry fee');
        setStatus('failed');
        return;
      }

      try {
        setError(null);

        // Waited for before the wallet is asked, because an unopened room makes
        // `enter_room` unsimulatable and the player would see only their wallet
        // refusing the transfer as unsafe.
        //
        // Waiting rather than failing: the countdown begins the instant the room
        // fills and the backend opens the room a few seconds behind it, so the
        // first attempt routinely lands in a gap that closes on its own. Telling
        // the player they would "sit this match out" over those few seconds was
        // simply wrong — the countdown had forty more.
        setStatus('preparing');

        if (!(await waitForRoomOnChain(connection, game))) {
          setStatus('failed');
          setError('This room did not open in time. Nothing was charged.');
          paidFor.current = null;
          return;
        }

        setStatus('awaiting-signature');

        const instruction = buildEnterRoomInstruction(publicKey, game);

        const { blockhash, lastValidBlockHeight } =
          await connection.getLatestBlockhash('confirmed');

        const message = new TransactionMessage({
          payerKey: publicKey,
          recentBlockhash: blockhash,
          instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }), instruction],
        }).compileToV0Message();

        setStatus('sending');
        const signature = await sendTransaction(new VersionedTransaction(message), connection);

        // Waited on locally so the countdown does not expire while the fee is
        // still in flight — the pot is read from the vault when the lobby
        // closes, and a late confirmation would leave this player out of a
        // match they paid for.
        await connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          'confirmed',
        );

        setStatus('paid');

        /**
         * Paid is ready.
         *
         * The countdown is sized for the slowest wallet approval, which is far
         * longer than a lobby where everyone has already paid should sit there
         * waiting. Readiness is what the state machine uses to cut it short, and
         * having paid is the only readiness that means anything in a staked
         * room — so the two are the same signal.
         *
         * Not awaited, and failures are swallowed: the fee is in the vault,
         * which is what the match is settled from. Missing the shortcut costs
         * seconds; surfacing it as a payment failure would be a lie.
         */
        onPaid?.();
      } catch (cause) {
        // Left failed rather than retried automatically. A rejected signature
        // is a decision, and re-prompting would be nagging; a genuine failure
        // is surfaced with a manual retry while the countdown runs.
        paidFor.current = null;
        setStatus('failed');
        setError(cause instanceof Error ? cause.message : 'Could not pay the entry fee');
      }
    },
    [publicKey, sendTransaction, connection, onPaid],
  );

  /**
   * Each countdown is a fresh chance to pay.
   *
   * The guard is keyed by game, so one attempt per game was one attempt ever —
   * and a room whose countdown expires unpaid starts another on the same game
   * id. A player who missed the wallet prompt, or whose first attempt failed
   * quietly, was never asked again, and sat in a room counting down at them for
   * ever. Clearing the guard when a new countdown begins asks once per
   * countdown instead, which is the thing actually being offered.
   */
  const wasCounting = useRef(false);

  useEffect(() => {
    if (counting && !wasCounting.current) paidFor.current = null;
    wasCounting.current = counting;
  }, [counting]);

  useEffect(() => {
    if (!counting || !gameId || entryFee === 0n) return;
    if (paidFor.current === gameId) return;

    paidFor.current = gameId;
    void pay(gameId);
  }, [counting, gameId, entryFee, pay]);

  const retry = useCallback(() => {
    if (!gameId) return;
    paidFor.current = gameId;
    void pay(gameId);
  }, [gameId, pay]);

  return { status, error, retry };
}
