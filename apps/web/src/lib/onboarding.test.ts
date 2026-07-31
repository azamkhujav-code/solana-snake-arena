import { describe, expect, it } from 'vitest';

import {
  buildSteps,
  currentStep,
  hasEnoughToPlay,
  type OnboardingState,
} from './onboarding';

const CHEAPEST = 10_000_000n; // 0.01 SOL, the bronze room

function state(overrides: Partial<OnboardingState> = {}): OnboardingState {
  return {
    hasWallet: true,
    connected: false,
    authenticated: false,
    spendableLamports: 0n,
    cheapestEntryFee: CHEAPEST,
    ...overrides,
  };
}

describe('onboarding progress', () => {
  it('starts at connect', () => {
    expect(currentStep(state())).toBe('connect');
  });

  it('asks for a signature once connected', () => {
    expect(currentStep(state({ connected: true }))).toBe('sign-in');
  });

  it('asks for a deposit once signed in with an empty balance', () => {
    expect(currentStep(state({ connected: true, authenticated: true }))).toBe('deposit');
  });

  it('is ready to play once the balance covers the cheapest room', () => {
    const ready = state({
      connected: true,
      authenticated: true,
      spendableLamports: CHEAPEST,
    });
    expect(currentStep(ready)).toBe('play');
  });

  it('still asks for a deposit one lamport short', () => {
    // The boundary is the whole point of the step; off-by-one here would let a
    // player through to a board where every room says "insufficient balance".
    const short = state({
      connected: true,
      authenticated: true,
      spendableLamports: CHEAPEST - 1n,
    });
    expect(currentStep(short)).toBe('deposit');
  });

  it('treats an unknown balance as sufficient', () => {
    // Otherwise the deposit step flashes on every page load for a funded
    // player, which reads as the app having lost their money.
    const loading = state({
      connected: true,
      authenticated: true,
      spendableLamports: null,
    });
    expect(hasEnoughToPlay(loading)).toBe(true);
    expect(currentStep(loading)).toBe('play');
  });

  it('regresses when the wallet disconnects', () => {
    // The reason this is derived rather than stored: disconnecting in the
    // extension has to walk the flow back, and a stored step would not.
    const wasReady = state({
      connected: true,
      authenticated: true,
      spendableLamports: CHEAPEST,
    });
    expect(currentStep({ ...wasReady, connected: false })).toBe('connect');
  });

  it('marks earlier steps done and later ones upcoming', () => {
    const steps = buildSteps(state({ connected: true, authenticated: true }));

    expect(steps.map((step) => step.status)).toEqual(['done', 'done', 'current', 'upcoming']);
  });

  it('tells a visitor with no wallet to install one', () => {
    const [connect] = buildSteps(state({ hasWallet: false }));

    expect(connect?.description).toMatch(/install phantom/i);
  });
});
