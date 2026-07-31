'use client';

import { getTier, LAMPORTS_PER_SOL, type MatchEnded } from '@arena/protocol';
import { Button, Panel } from '@arena/ui';

export interface MatchResultProps {
  result: MatchEnded | null;
  playerId: string | null;
  /** The tier this match was entered from; null for unranked play. */
  tierId: string | null;
  onLeave: () => void;
}

/** Lamports as a short SOL string, without trailing zeroes. */
function formatSol(lamports: bigint): string {
  const sol = Number(lamports) / Number(LAMPORTS_PER_SOL);
  return sol.toFixed(sol < 0.01 ? 4 : 3).replace(/\.?0+$/, '');
}

/**
 * The prize this match is paying out.
 *
 * Computed rather than reported, and exactly rather than approximately: a
 * staked room now starts only once every entrant's fee has confirmed on chain,
 * so the pot really is the entry fee times the number who played, and the rake
 * is fixed per tier. The server could have sent a figure, but it would have
 * been the same arithmetic done somewhere with less reason to be trusted — the
 * room has no view of the vault.
 *
 * Null for a free room, which has no pot and nothing to say about one.
 */
function prizeLamports(tierId: string | null, entrants: number): bigint | null {
  const tier = tierId ? getTier(tierId) : undefined;
  if (!tier || tier.entryFeeLamports === 0n) return null;

  const pot = tier.entryFeeLamports * BigInt(entrants);
  return pot - (pot * BigInt(tier.rakeBps)) / 10_000n;
}

/** Whether this match is known to have been free, as opposed to simply unknown. */
function knownFree(tierId: string | null): boolean {
  const tier = tierId ? getTier(tierId) : undefined;
  return tier !== undefined && tier.entryFeeLamports === 0n;
}

/**
 * Shown when the match resolves.
 *
 * The winner used to be left sitting in an empty arena. Nothing said the match
 * was over, nothing distinguished having won from everyone else having quit,
 * and nothing mentioned that a payout was on its way — so the only visible
 * outcome of winning a staked match was that the other snakes stopped moving.
 */
export function MatchResult({ result, playerId, tierId, onLeave }: MatchResultProps) {
  if (!result) return null;

  const won = result.winnerId !== null && result.winnerId === playerId;
  const prize = prizeLamports(tierId, result.entrants);
  const placement = result.standings.find((row) => row.playerId === playerId)?.placement ?? null;

  return (
    <div className="fixed inset-0 grid place-items-center bg-slate-950/70 p-4 backdrop-blur-sm">
      <Panel
        title={won ? 'You win' : 'Match over'}
        className="pointer-events-auto w-full max-w-sm text-center"
      >
        {won ? (
          <>
            <p className="text-sm text-slate-300">Last snake standing.</p>

            {prize === null ? (
              /*
               * Two different things used to read the same, and the wrong one
               * is expensive: a gold winner was told they had been in a
               * practice match with nothing to pay out. Saying "free" requires
               * knowing the room was free, and not knowing which room it was
               * is not the same fact.
               */
              <p className="my-5 text-sm text-slate-400">
                {knownFree(tierId)
                  ? 'A practice match — nothing was staked, so there is nothing to pay out.'
                  : 'Your winnings are being settled. Check your wallet in a few minutes.'}
              </p>
            ) : (
              <div className="my-5">
                <p className="text-xs uppercase tracking-widest text-slate-400">You won</p>
                <p className="text-4xl font-semibold tabular-nums text-emerald-400">
                  {formatSol(prize)} ◎
                </p>
                {/* Said plainly because it is not instant: settlement runs on
                    the match cycle, so the lamports arrive shortly after this
                    screen does, and a player watching their balance needs to
                    know that is expected rather than broken. */}
                <p className="mt-2 text-xs text-slate-400">
                  Being sent to your wallet now. It lands within a few minutes.
                </p>
              </div>
            )}
          </>
        ) : (
          <>
            <p className="text-sm text-slate-300">
              {result.winnerNickname ? `${result.winnerNickname} took it.` : 'The match is over.'}
            </p>
            <p className="my-5 text-sm text-slate-400">
              {placement === null
                ? 'Better luck in the next one.'
                : `You finished ${placement} of ${result.entrants}.`}
            </p>
          </>
        )}

        <Button className="w-full" onClick={onLeave}>
          Back to rooms
        </Button>
      </Panel>
    </div>
  );
}
