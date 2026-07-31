import { describe, expect, it } from 'vitest';

import { chatPayloadSchema, EventGuard, sanitiseChat } from './event-guard.js';

describe('EventGuard', () => {
  it('allows a burst then throttles', () => {
    const guard = new EventGuard();

    // Chat burst is 3.
    expect(guard.allow('chat', 0)).toBe(true);
    expect(guard.allow('chat', 0)).toBe(true);
    expect(guard.allow('chat', 0)).toBe(true);
    expect(guard.allow('chat', 0)).toBe(false);
  });

  it('refills over time', () => {
    const guard = new EventGuard();
    for (let i = 0; i < 3; i += 1) guard.allow('chat', 0);

    // 0.5/s means two seconds buys exactly one message.
    expect(guard.allow('chat', 2_000)).toBe(true);
    expect(guard.allow('chat', 2_000)).toBe(false);
  });

  it('keeps events independent', () => {
    // Spamming chat must not stop the client measuring its latency, or the
    // punishment degrades interpolation for everyone they can see.
    const guard = new EventGuard();
    for (let i = 0; i < 5; i += 1) guard.allow('chat', 0);

    expect(guard.allow('ping', 0)).toBe(true);
  });

  it('leaves unlisted events unlimited', () => {
    // Silently throttling something nobody configured is a surprising failure
    // to debug; the caller decides what to police.
    const guard = new EventGuard();

    for (let i = 0; i < 1_000; i += 1) {
      expect(guard.allow('leave', 0)).toBe(true);
    }
  });

  it('never banks credit beyond the burst', () => {
    const guard = new EventGuard();
    guard.allow('chat', 0);

    for (let i = 0; i < 3; i += 1) {
      expect(guard.allow('chat', 3_600_000)).toBe(true);
    }
    expect(guard.allow('chat', 3_600_000)).toBe(false);
  });
});

describe('chatPayloadSchema', () => {
  it('accepts an ordinary message', () => {
    expect(chatPayloadSchema.safeParse({ body: 'gg' }).success).toBe(true);
  });

  it('rejects an oversized body at parse time', () => {
    // Rejected rather than truncated: a megabyte string that gets sliced to 140
    // characters was still received, parsed and held in memory first.
    expect(chatPayloadSchema.safeParse({ body: 'x'.repeat(141) }).success).toBe(false);
  });

  it('rejects a missing or wrongly-typed body', () => {
    // The old handler read `payload.body` directly, so a null payload threw
    // inside the socket handler.
    expect(chatPayloadSchema.safeParse({}).success).toBe(false);
    expect(chatPayloadSchema.safeParse(null).success).toBe(false);
    expect(chatPayloadSchema.safeParse({ body: 42 }).success).toBe(false);
    expect(chatPayloadSchema.safeParse({ body: '' }).success).toBe(false);
  });
});

describe('sanitiseChat', () => {
  it('passes ordinary text through', () => {
    expect(sanitiseChat('nice snake')).toBe('nice snake');
  });

  it('collapses whitespace runs', () => {
    // Otherwise a sender pushes everyone else's messages off screen with
    // newlines while staying inside the length limit.
    expect(sanitiseChat('a\n\n\n\n\nb')).toBe('a b');
    expect(sanitiseChat('a      b')).toBe('a b');
  });

  it('strips zero-width characters', () => {
    // They render as nothing, so a sender can pad a message to look like it
    // came from someone else while passing every length check.
    expect(sanitiseChat('a\u200bb\u200dc')).toBe('abc');
  });

  it('strips bidirectional overrides', () => {
    // U+202E reverses the visual order of everything after it — enough to make
    // a message read as an entirely different one.
    expect(sanitiseChat('safe\u202egnihsihp')).toBe('safegnihsihp');
  });

  it('strips control characters', () => {
    expect(sanitiseChat('a\u0000\u0007b')).toBe('ab');
  });

  it('returns null for a message that was only invisible characters', () => {
    // Not a message, and forwarding it would let someone flood the room with
    // blank lines.
    expect(sanitiseChat('\u200b\u200b\u200b')).toBeNull();
    expect(sanitiseChat('   ')).toBeNull();
  });

  it('caps the result even if sanitising did not shorten it', () => {
    expect(sanitiseChat('x'.repeat(500))?.length).toBe(140);
  });
});
