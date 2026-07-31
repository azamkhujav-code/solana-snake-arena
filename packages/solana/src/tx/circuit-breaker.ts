import { SolanaServiceError } from '../errors.js';

/**
 * Circuit breaker for RPC calls.
 *
 * Retry alone makes an outage worse. When an endpoint is down, every request
 * spends four attempts and several seconds of backoff before failing — so the
 * struggling endpoint receives *more* traffic than when it was healthy, and
 * every one of our request handlers stays open for the duration. That is how a
 * dependency's bad minute becomes our bad hour.
 *
 * The breaker turns the second failure onward into an immediate rejection.
 * Failing in a millisecond is strictly better than failing in eight seconds:
 * the caller learns the same thing and nobody's connection pool fills up.
 *
 * States:
 *
 *   closed    -> normal. Failures counted in a rolling window.
 *   open      -> reject immediately. Entered when the window exceeds threshold.
 *   half-open -> after the cooldown, let exactly one probe through. Success
 *                closes the circuit; failure re-opens it.
 *
 * The single probe matters. Reopening the floodgates after a cooldown sends the
 * full backlog at an endpoint that has had no time to recover, and the cycle
 * repeats — a pattern that reads as flapping in the metrics and is usually
 * blamed on the endpoint.
 */

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Failures within the window before the circuit opens. */
  failureThreshold: number;
  /** Rolling window for counting failures. */
  windowMs: number;
  /** How long to reject outright before allowing a probe. */
  cooldownMs: number;
  /** Consecutive probe successes required to fully close again. */
  successThreshold: number;
}

export const DEFAULT_BREAKER: CircuitBreakerOptions = {
  failureThreshold: 5,
  windowMs: 30_000,
  cooldownMs: 10_000,
  successThreshold: 2,
};

export class CircuitOpenError extends SolanaServiceError {
  constructor(readonly retryAfterMs: number) {
    super(`RPC circuit is open; retry in ${Math.ceil(retryAfterMs / 1000)}s`, {
      // Retryable in the sense that it will succeed later, but the caller must
      // not retry it *now* — that is the whole point of the breaker.
      retryable: true,
    });
    this.name = 'CircuitOpenError';
  }
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures: number[] = [];
  private openedAtMs = 0;
  private probeSuccesses = 0;
  /** Set while a half-open probe is in flight, so only one is ever loose. */
  private probeInFlight = false;

  constructor(private readonly options: CircuitBreakerOptions = DEFAULT_BREAKER) {}

  /** Exposed for metrics and for the health endpoint. */
  get currentState(): CircuitState {
    return this.state;
  }

  get failureCount(): number {
    return this.failures.length;
  }

  /**
   * Whether a call may proceed, and as what.
   *
   * Returns the role so the caller can report the result correctly: a probe
   * that succeeds closes the circuit, whereas an ordinary success in the closed
   * state means nothing in particular.
   */
  private admit(now: number): { allowed: boolean; probe: boolean; retryAfterMs: number } {
    if (this.state === 'closed') return { allowed: true, probe: false, retryAfterMs: 0 };

    const elapsed = now - this.openedAtMs;

    if (this.state === 'open') {
      if (elapsed < this.options.cooldownMs) {
        return { allowed: false, probe: false, retryAfterMs: this.options.cooldownMs - elapsed };
      }
      this.state = 'half-open';
      this.probeSuccesses = 0;
      this.probeInFlight = false;
    }

    // half-open: exactly one caller gets through at a time. Without this,
    // everything queued during the cooldown arrives at once and re-opens the
    // circuit on an endpoint that never got a chance to recover.
    if (this.probeInFlight) {
      return { allowed: false, probe: false, retryAfterMs: this.options.cooldownMs };
    }

    this.probeInFlight = true;
    return { allowed: true, probe: true, retryAfterMs: 0 };
  }

  private onSuccess(probe: boolean): void {
    if (probe) {
      this.probeInFlight = false;
      this.probeSuccesses += 1;

      if (this.probeSuccesses >= this.options.successThreshold) {
        this.state = 'closed';
        this.failures = [];
        this.probeSuccesses = 0;
      }
      return;
    }

    // A success in the closed state does not clear history — the window does
    // that on its own. Clearing here would let a service failing half its calls
    // stay closed forever, since every other call resets the counter.
    if (this.state === 'closed') this.failures = [];
  }

  private onFailure(now: number, probe: boolean): void {
    if (probe) {
      // The probe failed: straight back to open, and the cooldown restarts.
      this.probeInFlight = false;
      this.state = 'open';
      this.openedAtMs = now;
      return;
    }

    this.failures.push(now);
    this.failures = this.failures.filter((at) => now - at < this.options.windowMs);

    if (this.failures.length >= this.options.failureThreshold) {
      this.state = 'open';
      this.openedAtMs = now;
    }
  }

  /**
   * Runs `fn` under the breaker.
   *
   * `now` is injected rather than read from the clock so the state machine can
   * be tested without real time — the transitions are the part worth proving,
   * and asserting them through `setTimeout` makes for a slow, flaky suite.
   */
  async execute<T>(fn: () => Promise<T>, now: number = Date.now()): Promise<T> {
    const decision = this.admit(now);

    if (!decision.allowed) {
      throw new CircuitOpenError(decision.retryAfterMs);
    }

    try {
      const result = await fn();
      this.onSuccess(decision.probe);
      return result;
    } catch (error) {
      this.onFailure(now, decision.probe);
      throw error;
    }
  }

  /** Forces the circuit shut. For an operator override and for tests. */
  reset(): void {
    this.state = 'closed';
    this.failures = [];
    this.probeSuccesses = 0;
    this.probeInFlight = false;
  }
}
