// Constants and errors
export * from './constants.js';
export * from './errors.js';

// Addresses
export * from './pda.js';

// Connection
export { createConnection, RpcPool } from './connection.js';
export type { RpcEndpoint, RpcPoolOptions } from './connection.js';

// Instruction builders
export * from './instructions.js';

// Transaction machinery
export { TransactionBuilder } from './tx/builder.js';
export type { BuildOptions } from './tx/builder.js';
export { sendAndConfirm } from './tx/confirm.js';
export type { SendAndConfirmOptions } from './tx/confirm.js';
export * from './tx/encode.js';
export {
  parseAnchorEvents,
  parseBalanceChanges,
  parseErrorCodeFromLogs,
  summarizeTransaction,
  verifyIncomingTransfer,
} from './tx/parse.js';
export type { ParsedArenaEvent, ParsedTransactionSummary, ParsedTransferLeg } from './tx/parse.js';
export { CircuitBreaker, CircuitOpenError, DEFAULT_BREAKER } from './tx/circuit-breaker.js';
export type { CircuitBreakerOptions, CircuitState } from './tx/circuit-breaker.js';
export { computeBackoff, withRetry } from './tx/retry.js';
export type { RetryOptions } from './tx/retry.js';

// Auth
export { buildAuthMessage, parseAuthMessage } from './auth/message.js';
export type { AuthMessageParams } from './auth/message.js';
export { assertValidSignature, verifyAuthSignature, verifySignature } from './auth/verify.js';
export type { VerifyAuthParams, VerifySignatureParams } from './auth/verify.js';

// Custody verification
export * from './verify-custody.js';

// Service
export { ArenaService } from './service.js';
export type { ArenaServiceOptions, SendResult } from './service.js';
