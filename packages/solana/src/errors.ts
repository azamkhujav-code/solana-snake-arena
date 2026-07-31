import { ARENA_ERROR_CODES, RETRYABLE_RPC_ERRORS } from './constants.js';

/** Base class so callers can catch everything this SDK throws with one clause. */
export class SolanaServiceError extends Error {
  readonly retryable: boolean;
  override readonly cause?: unknown;

  constructor(message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message);
    this.name = 'SolanaServiceError';
    this.retryable = options.retryable ?? false;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/** The program rejected the instruction with one of its own error codes. */
export class ProgramError extends SolanaServiceError {
  readonly code: number;
  readonly errorName: string;
  readonly logs: readonly string[];

  constructor(code: number, logs: readonly string[] = [], cause?: unknown) {
    const name = ARENA_ERROR_CODES[code] ?? `Unknown(${code})`;
    // Program errors are deterministic: the same inputs fail the same way, so
    // retrying is always pointless and sometimes harmful (it burns rate limit).
    super(`Arena program error ${code}: ${name}`, { retryable: false, cause });
    this.name = 'ProgramError';
    this.code = code;
    this.errorName = name;
    this.logs = logs;
  }
}

/** The RPC endpoint failed, but the transaction may still be valid. */
export class RpcError extends SolanaServiceError {
  constructor(message: string, retryable: boolean, cause?: unknown) {
    super(message, { retryable, cause });
    this.name = 'RpcError';
  }
}

/** The transaction was sent but never reached the requested commitment. */
export class ConfirmationTimeoutError extends SolanaServiceError {
  readonly signature: string;

  constructor(signature: string, timeoutMs: number) {
    super(
      `Transaction ${signature} was not confirmed within ${timeoutMs}ms. ` +
        `It may still land — check the signature before resubmitting.`,
      { retryable: false },
    );
    this.name = 'ConfirmationTimeoutError';
    this.signature = signature;
  }
}

/** A signature did not verify against the claimed wallet. */
export class SignatureVerificationError extends SolanaServiceError {
  constructor(reason: string) {
    super(`Signature verification failed: ${reason}`, { retryable: false });
    this.name = 'SignatureVerificationError';
  }
}

/** Phantom is missing, locked, or the user rejected the request. */
export class WalletError extends SolanaServiceError {
  readonly reason: 'not-found' | 'not-connected' | 'rejected' | 'unknown';

  constructor(reason: WalletError['reason'], message: string, cause?: unknown) {
    super(message, { retryable: false, cause });
    this.name = 'WalletError';
    this.reason = reason;
  }
}

/**
 * Extracts an Anchor custom error code from whatever shape the RPC returned.
 *
 * The code appears in three different places depending on whether the failure
 * came from simulation, from `sendTransaction`, or from a confirmed-but-failed
 * transaction, so all three are checked.
 */
export function extractProgramErrorCode(error: unknown): number | null {
  const asRecord = error as
    | { InstructionError?: [number, { Custom?: number }]; err?: unknown; logs?: string[] }
    | undefined;

  const instructionError =
    asRecord?.InstructionError ??
    (asRecord?.err as { InstructionError?: [number, { Custom?: number }] } | undefined)
      ?.InstructionError;

  if (Array.isArray(instructionError)) {
    const detail = instructionError[1];
    if (detail && typeof detail === 'object' && typeof detail.Custom === 'number') {
      return detail.Custom;
    }
  }

  const message = error instanceof Error ? error.message : String(error ?? '');

  const hexMatch = /custom program error: 0x([0-9a-fA-F]+)/.exec(message);
  if (hexMatch?.[1]) return Number.parseInt(hexMatch[1], 16);

  const decimalMatch = /Custom(?:\s*[:(]\s*|\s+)(\d+)/.exec(message);
  if (decimalMatch?.[1]) return Number.parseInt(decimalMatch[1], 10);

  return null;
}

/** Whether a failure is worth another attempt. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof SolanaServiceError) return error.retryable;

  const message = error instanceof Error ? error.message : String(error ?? '');
  return RETRYABLE_RPC_ERRORS.some((needle) => message.includes(needle));
}

/** Normalises anything thrown by web3.js into this SDK's error hierarchy. */
export function toServiceError(error: unknown, logs: readonly string[] = []): SolanaServiceError {
  if (error instanceof SolanaServiceError) return error;

  const code = extractProgramErrorCode(error);
  if (code !== null) return new ProgramError(code, logs, error);

  const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  return new RpcError(message, isRetryable(error), error);
}
