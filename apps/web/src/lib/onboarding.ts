/**
 * How far a player has got towards being able to play.
 *
 * Derived from live state on every render rather than stored as a wizard
 * position. A stored step is a second source of truth that goes stale the
 * moment anything happens outside the wizard — disconnecting the wallet in
 * Phantom, a session expiring, a withdrawal draining the balance — and the
 * symptom is a UI insisting you are ready to play when you are not.
 *
 * Pure, and separate from the component, because every branch here is a state
 * somebody will actually be in and each one needs its own copy.
 */

export type OnboardingStepId = 'connect' | 'sign-in' | 'deposit' | 'play';

export interface OnboardingState {
  /** Whether a wallet extension is available at all. */
  hasWallet: boolean;
  connected: boolean;
  authenticated: boolean;
  /** Spendable custody balance. Null while loading. */
  spendableLamports: bigint | null;
  /** The cheapest paid room, so "enough to play" is a real threshold. */
  cheapestEntryFee: bigint;
}

export interface OnboardingStep {
  id: OnboardingStepId;
  title: string;
  description: string;
  status: 'done' | 'current' | 'upcoming';
}

/** The first step that is not yet done. */
export function currentStep(state: OnboardingState): OnboardingStepId {
  if (!state.connected) return 'connect';
  if (!state.authenticated) return 'sign-in';
  if (!hasEnoughToPlay(state)) return 'deposit';
  return 'play';
}

/**
 * Whether the balance covers the cheapest paid room.
 *
 * Unknown counts as sufficient. Treating a loading balance as "not enough"
 * would flash the deposit step on every page load for a funded player, which
 * reads as the app forgetting their money.
 */
export function hasEnoughToPlay(state: OnboardingState): boolean {
  if (state.spendableLamports === null) return true;
  return state.spendableLamports >= state.cheapestEntryFee;
}

export function buildSteps(state: OnboardingState): OnboardingStep[] {
  const current = currentStep(state);
  const order: OnboardingStepId[] = ['connect', 'sign-in', 'deposit', 'play'];
  const currentIndex = order.indexOf(current);

  const copy: Record<OnboardingStepId, { title: string; description: string }> = {
    connect: {
      title: 'Connect your wallet',
      description: state.hasWallet
        ? 'Approve the connection in Phantom.'
        : 'Install Phantom, then reload this page.',
    },
    'sign-in': {
      title: 'Sign in',
      description:
        'Sign a short message to prove the wallet is yours. It is free and moves no SOL.',
    },
    deposit: {
      title: 'Deposit devnet SOL',
      description:
        'Move test SOL into your platform balance. Entry fees come out of this, and you can withdraw it at any time.',
    },
    play: {
      title: 'Pick a room and play',
      description: 'Confirm the entry fee, then outlive everyone else to take the pot.',
    },
  };

  return order.map((id, index) => ({
    id,
    ...copy[id],
    status: index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'upcoming',
  }));
}
