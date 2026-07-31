/**
 * Result verification.
 *
 * The realtime node is trusted to *report* who won, but not blindly. It is a
 * separate process that can crash mid-write, be restarted with stale state, or
 * — if compromised — report whatever it likes. Every claim is therefore checked
 * against what the settlement side already knows: who actually joined, and how
 * much was actually escrowed.
 *
 * Pure, so every rejection path can be tested without a chain or a database.
 */

export interface ReportedStanding {
  playerId: string;
  /** 1 is the winner. Must form a gapless permutation across the report. */
  placement: number;
  score: number;
  kills: number;
  survivedMs: number;
}

export interface MatchResultReport {
  gameId: string;
  roomId: string;
  nodeId: string;
  standings: ReportedStanding[];
  endedAtMs: number;
}

export type VerificationFailure =
  | 'no-standings'
  | 'unknown-player'
  | 'missing-player'
  | 'duplicate-player'
  | 'invalid-placement'
  | 'negative-metric'
  | 'wrong-game'
  | 'wrong-node';

export interface VerifiedResult {
  ok: boolean;
  failures: VerificationFailure[];
  /** Standings sorted by placement, present only when `ok`. */
  standings: ReportedStanding[];
}

export interface VerificationContext {
  gameId: string;
  /** Players the settlement side recorded as having joined and paid. */
  entrants: readonly string[];
  /** Node the game was placed on, if placement recorded one. */
  expectedNodeId?: string | undefined;
}

/**
 * Checks a reported result against the recorded entrants.
 *
 * Collects every failure rather than returning on the first, so an operator
 * investigating a rejected settlement sees the whole picture instead of
 * peeling problems off one at a time.
 */
export function verifyResult(
  report: MatchResultReport,
  context: VerificationContext,
): VerifiedResult {
  const failures: VerificationFailure[] = [];

  if (report.gameId !== context.gameId) failures.push('wrong-game');
  if (context.expectedNodeId && report.nodeId !== context.expectedNodeId) {
    // A result from a node that never hosted this game is either a bug or an
    // attempt to settle someone else's match.
    failures.push('wrong-node');
  }

  if (report.standings.length === 0) {
    failures.push('no-standings');
    return { ok: false, failures, standings: [] };
  }

  const entrants = new Set(context.entrants);
  const seen = new Set<string>();

  for (const standing of report.standings) {
    if (seen.has(standing.playerId)) failures.push('duplicate-player');
    seen.add(standing.playerId);

    // A player who never paid an entry fee must never receive a payout.
    if (!entrants.has(standing.playerId)) failures.push('unknown-player');

    if (
      !Number.isFinite(standing.score) ||
      standing.score < 0 ||
      !Number.isFinite(standing.kills) ||
      standing.kills < 0 ||
      !Number.isFinite(standing.survivedMs) ||
      standing.survivedMs < 0
    ) {
      failures.push('negative-metric');
    }
  }

  // Everyone who paid must appear. A missing entrant would silently forfeit
  // their stake into the remainder.
  for (const entrant of entrants) {
    if (!seen.has(entrant)) failures.push('missing-player');
  }

  // Placements must be exactly 1..N. A gap or a duplicate makes the payout
  // table ambiguous, and "ambiguous" here means someone is paid twice.
  const placements = report.standings.map((standing) => standing.placement).sort((a, b) => a - b);
  for (let i = 0; i < placements.length; i += 1) {
    if (placements[i] !== i + 1) {
      failures.push('invalid-placement');
      break;
    }
  }

  const unique = [...new Set(failures)];
  if (unique.length > 0) return { ok: false, failures: unique, standings: [] };

  return {
    ok: true,
    failures: [],
    standings: [...report.standings].sort((a, b) => a.placement - b.placement),
  };
}

/** The winner, or null when the result did not verify. */
export function detectWinner(result: VerifiedResult): ReportedStanding | null {
  if (!result.ok) return null;
  return result.standings.find((standing) => standing.placement === 1) ?? null;
}

export function describeFailure(failure: VerificationFailure): string {
  switch (failure) {
    case 'no-standings':
      return 'The report contained no standings';
    case 'unknown-player':
      return 'A reported player never entered this game';
    case 'missing-player':
      return 'An entrant is missing from the report';
    case 'duplicate-player':
      return 'A player appears more than once';
    case 'invalid-placement':
      return 'Placements are not a gapless 1..N sequence';
    case 'negative-metric':
      return 'A score, kill count or duration was negative or non-finite';
    case 'wrong-game':
      return 'The report is for a different game';
    case 'wrong-node':
      return 'The report came from a node that did not host this game';
    default:
      return 'Unknown verification failure';
  }
}
