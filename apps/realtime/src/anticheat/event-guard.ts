import { z } from 'zod';

/**
 * Per-socket, per-event rate limiting and payload validation.
 *
 * The input path already has both. Everything else — chat, ping, respawn —
 * had neither, and each is a way to make the server work without ever sending
 * a game packet:
 *
 *  - `chat` fans out to every socket in the room, so one sender multiplies into
 *    N sends. It is the cheapest amplification available to a client.
 *  - `ping` is answered synchronously and costs a room-state read.
 *  - `respawn` mutates the world and allocates a snake.
 *
 * None is expensive alone. All are expensive at a thousand per second, and
 * nothing stops a modified client sending them at that rate.
 */

export interface EventBudget {
  tokens: number;
  lastRefillMs: number;
}

export interface EventLimit {
  ratePerSecond: number;
  burst: number;
}

/**
 * Per-event budgets.
 *
 * Chat is the tightest because it is the one that fans out. Ping is generous
 * because a client legitimately re-pings on a network change, and throttling a
 * latency probe degrades the very interpolation it feeds.
 */
export const EVENT_LIMITS: Readonly<Record<string, EventLimit>> = Object.freeze({
  chat: { ratePerSecond: 0.5, burst: 3 },
  ping: { ratePerSecond: 4, burst: 8 },
  respawn: { ratePerSecond: 0.5, burst: 3 },
  join: { ratePerSecond: 1, burst: 3 },
});

/** One socket's budgets across every limited event. */
export class EventGuard {
  private readonly budgets = new Map<string, EventBudget>();

  /** True when the event is allowed; consumes a token if so. */
  allow(event: string, now: number): boolean {
    const limit = EVENT_LIMITS[event];
    // An unlisted event is unlimited by design — the caller decides what to
    // police, and silently throttling something nobody configured would be a
    // surprising failure to debug.
    if (!limit) return true;

    let budget = this.budgets.get(event);
    if (!budget) {
      budget = { tokens: limit.burst, lastRefillMs: now };
      this.budgets.set(event, budget);
    }

    const elapsed = Math.max(0, now - budget.lastRefillMs);
    budget.lastRefillMs = now;
    budget.tokens = Math.min(limit.burst, budget.tokens + (elapsed / 1_000) * limit.ratePerSecond);

    if (budget.tokens < 1) return false;

    budget.tokens -= 1;
    return true;
  }
}

/**
 * Chat payload.
 *
 * Length is capped at the schema rather than by slicing after the fact: a
 * megabyte string that gets truncated to 140 characters was still received,
 * parsed and held in memory first.
 */
export const chatPayloadSchema = z.object({
  body: z.string().min(1).max(140),
});

/**
 * Strips control characters and collapses runs of whitespace.
 *
 * Zero-width and bidirectional-override characters are the interesting ones:
 * they render as nothing but let a sender spoof the appearance of another
 * player's name, or reverse the visual order of a line. Length limits do not
 * catch them because they are, by character count, tiny.
 */
export function sanitiseChat(body: string): string | null {
  const cleaned = body
    // Whitespace first. Newlines and tabs live in the C0 control range, so
    // stripping controls before this would delete them outright and silently
    // join words that were on separate lines — changing what was said rather
    // than merely reformatting it.
    .replace(/\s+/g, ' ')
    // Remaining C0/C1 controls, zero-width characters, and the bidi overrides.
    // Written as escapes rather than literals: a literal control character in
    // source is invisible in review, which is how one gets deleted by accident.
    // eslint-disable-next-line no-control-regex -- stripping controls is the point
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .trim();

  // Emptied by sanitising means the message was *only* invisible characters,
  // which is not a message.
  return cleaned.length === 0 ? null : cleaned.slice(0, 140);
}
