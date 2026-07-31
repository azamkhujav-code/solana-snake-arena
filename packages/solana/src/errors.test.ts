import { describe, expect, it } from 'vitest';

import { ARENA_ERROR_CODES } from './constants.js';
import {
  extractProgramErrorCode,
  isRetryable,
  ProgramError,
  RpcError,
  toServiceError,
} from './errors.js';

describe('extractProgramErrorCode', () => {
  it('reads the code from a simulation InstructionError', () => {
    expect(extractProgramErrorCode({ InstructionError: [0, { Custom: 6033 }] })).toBe(6033);
  });

  it('reads the code from a confirmed transaction err field', () => {
    expect(extractProgramErrorCode({ err: { InstructionError: [1, { Custom: 6009 }] } })).toBe(
      6009,
    );
  });

  it('reads the hex form out of an error message', () => {
    // 0x1771 = 6001 = UnauthorizedAdmin
    const error = new Error('Transaction failed: custom program error: 0x1771');
    expect(extractProgramErrorCode(error)).toBe(6001);
  });

  it('returns null when there is no program error', () => {
    expect(extractProgramErrorCode(new Error('socket hang up'))).toBeNull();
    expect(extractProgramErrorCode(null)).toBeNull();
    expect(extractProgramErrorCode(undefined)).toBeNull();
  });
});

describe('ProgramError', () => {
  it('maps a code to its declared name', () => {
    expect(new ProgramError(6033).errorName).toBe('PayoutMismatch');
    expect(new ProgramError(6002).errorName).toBe('UnauthorizedSettlement');
    expect(new ProgramError(6011).errorName).toBe('WouldBreakRentExemption');
  });

  it('labels an unmapped code rather than throwing', () => {
    expect(new ProgramError(9999).errorName).toBe('Unknown(9999)');
  });

  it('is never retryable', () => {
    expect(new ProgramError(6009).retryable).toBe(false);
  });

  it('covers the full contiguous code range declared by the program', () => {
    const codes = Object.keys(ARENA_ERROR_CODES)
      .map(Number)
      .sort((a, b) => a - b);
    expect(codes[0]).toBe(6000);
    // A gap means the table drifted from the Rust enum, and every code after
    // the gap would then map to the wrong name.
    codes.forEach((code, index) => expect(code).toBe(6000 + index));
  });
});

describe('isRetryable', () => {
  it('treats transient RPC failures as retryable', () => {
    expect(isRetryable(new Error('BlockhashNotFound'))).toBe(true);
    expect(isRetryable(new Error('429 Too Many Requests'))).toBe(true);
    expect(isRetryable(new Error('ECONNRESET'))).toBe(true);
    expect(isRetryable(new Error('Node is behind by 200 slots'))).toBe(true);
  });

  it('treats program and unknown errors as non-retryable', () => {
    expect(isRetryable(new ProgramError(6033))).toBe(false);
    expect(isRetryable(new Error('something specific broke'))).toBe(false);
  });

  it('honours the flag on an explicit RpcError', () => {
    expect(isRetryable(new RpcError('anything', true))).toBe(true);
    expect(isRetryable(new RpcError('anything', false))).toBe(false);
  });
});

describe('toServiceError', () => {
  it('converts a custom program error into a ProgramError', () => {
    const converted = toServiceError(new Error('custom program error: 0x1779'));
    expect(converted).toBeInstanceOf(ProgramError);
    expect((converted as ProgramError).code).toBe(6009);
  });

  it('converts an RPC failure into a retryable RpcError', () => {
    const converted = toServiceError(new Error('fetch failed'));
    expect(converted).toBeInstanceOf(RpcError);
    expect(converted.retryable).toBe(true);
  });

  it('passes an existing service error through unchanged', () => {
    const original = new ProgramError(6000);
    expect(toServiceError(original)).toBe(original);
  });
});
