import type { ParsedTransactionWithMeta, PublicKey } from '@solana/web3.js';

import { ARENA_ERROR_CODES } from '../constants.js';

/**
 * Transaction and log parsing.
 *
 * The deposit watcher and the settlement reconciler both read chain history
 * rather than trusting their own optimistic writes, so this is the code that
 * decides whether money actually moved.
 */

export interface ParsedTransferLeg {
  source: string;
  destination: string;
  lamports: bigint;
}

export interface ParsedArenaEvent {
  name: string;
  /** Base64 payload as emitted by Anchor's `emit!`. */
  dataBase64: string;
}

export interface ParsedTransactionSummary {
  signature: string;
  slot: number;
  blockTime: number | null;
  success: boolean;
  errorCode: number | null;
  errorName: string | null;
  fee: bigint;
  logs: string[];
  events: ParsedArenaEvent[];
  transfers: ParsedTransferLeg[];
}

const PROGRAM_DATA_PREFIX = 'Program data: ';

/**
 * Extracts Anchor event payloads from transaction logs.
 *
 * Anchor emits events as base64 on `Program data:` lines. Decoding the payload
 * into typed fields needs the IDL, so the raw payload is returned here and
 * decoded by the caller that has it.
 */
export function parseAnchorEvents(logs: readonly string[]): ParsedArenaEvent[] {
  const events: ParsedArenaEvent[] = [];

  for (const line of logs) {
    if (!line.startsWith(PROGRAM_DATA_PREFIX)) continue;
    const dataBase64 = line.slice(PROGRAM_DATA_PREFIX.length).trim();
    if (dataBase64.length === 0) continue;
    events.push({ name: 'unknown', dataBase64 });
  }

  return events;
}

/**
 * Pulls the Anchor error code out of transaction logs.
 *
 * Logs are the only place the code appears for an already-confirmed failure —
 * `meta.err` gives the instruction index but reports the code as an opaque
 * `Custom` value.
 */
export function parseErrorCodeFromLogs(logs: readonly string[]): number | null {
  for (const line of logs) {
    const hex = /custom program error: 0x([0-9a-fA-F]+)/.exec(line);
    if (hex?.[1]) return Number.parseInt(hex[1], 16);

    const anchorLine = /Error Code: (\w+)\. Error Number: (\d+)/.exec(line);
    if (anchorLine?.[2]) return Number.parseInt(anchorLine[2], 10);
  }
  return null;
}

/**
 * Computes net lamport movement per account from pre/post balances.
 *
 * Deliberately derived from balances rather than from parsed instructions: a
 * transfer can happen inside a CPI that never appears as a top-level System
 * Program instruction, and this program's vault transfers are exactly that.
 */
export function parseBalanceChanges(transaction: ParsedTransactionWithMeta): Map<string, bigint> {
  const changes = new Map<string, bigint>();
  const meta = transaction.meta;
  if (!meta) return changes;

  const keys = transaction.transaction.message.accountKeys;

  keys.forEach((key, index) => {
    const pre = BigInt(meta.preBalances[index] ?? 0);
    const post = BigInt(meta.postBalances[index] ?? 0);
    const delta = post - pre;
    if (delta !== 0n) {
      changes.set(key.pubkey.toBase58(), delta);
    }
  });

  return changes;
}

/**
 * Verifies that a transaction credited `destination` by at least `minLamports`.
 *
 * This is the check the deposit watcher runs before crediting a custody
 * balance. Matching on the signature alone is not enough — an attacker can
 * point the watcher at any real transaction. The destination and amount must
 * be confirmed from the chain's own accounting.
 */
export function verifyIncomingTransfer(
  transaction: ParsedTransactionWithMeta,
  destination: PublicKey,
  minLamports: bigint,
): { ok: boolean; credited: bigint } {
  if (transaction.meta?.err) return { ok: false, credited: 0n };

  const changes = parseBalanceChanges(transaction);
  const credited = changes.get(destination.toBase58()) ?? 0n;

  return { ok: credited >= minLamports, credited };
}

/** Normalises a fetched transaction into a flat summary. */
export function summarizeTransaction(
  signature: string,
  transaction: ParsedTransactionWithMeta,
): ParsedTransactionSummary {
  const logs = transaction.meta?.logMessages ?? [];
  const errorCode = transaction.meta?.err ? parseErrorCodeFromLogs(logs) : null;

  const changes = parseBalanceChanges(transaction);
  const transfers: ParsedTransferLeg[] = [];
  const sources = [...changes.entries()].filter(([, delta]) => delta < 0n);
  const destinations = [...changes.entries()].filter(([, delta]) => delta > 0n);

  // Pairing is best-effort: with several legs in one transaction, balance
  // deltas alone cannot prove which source funded which destination.
  for (const [destination, credited] of destinations) {
    const source = sources[0]?.[0] ?? 'unknown';
    transfers.push({ source, destination, lamports: credited });
  }

  return {
    signature,
    slot: transaction.slot,
    blockTime: transaction.blockTime ?? null,
    success: !transaction.meta?.err,
    errorCode,
    errorName: errorCode === null ? null : (ARENA_ERROR_CODES[errorCode] ?? null),
    fee: BigInt(transaction.meta?.fee ?? 0),
    logs,
    events: parseAnchorEvents(logs),
    transfers,
  };
}
