'use client';

import { Button } from '@arena/ui';
import { useWallet } from '@solana/wallet-adapter-react';

import { useAuth } from '@/hooks/use-auth';
import { useCustodyBalance } from '@/hooks/use-custody';
import { useMounted } from '@/hooks/use-mounted';
import { useProgramDeployed } from '@/hooks/use-program-status';
import { useWalletConnect } from '@/hooks/use-wallet-connect';
import { cheapestPaidEntryFee } from '@/lib/tiers';
import { formatSolShort } from '@/lib/lobby-state';
import { buildSteps, currentStep, type OnboardingState } from '@/lib/onboarding';
import { useSessionStore } from '@/stores/session-store';
import { useWalletStore } from '@/stores/wallet-store';

/**
 * The path from landing on the page to being able to play.
 *
 * Four things have to happen — connect, sign in, deposit, join — and each fails
 * differently. Presenting them as one screen with everything visible meant a
 * new player saw a room board they could not use, buttons that reported
 * "insufficient balance" with no route to fixing it, and no indication of which
 * of the four was actually blocking them.
 *
 * The steps are derived from live state, so the list walks backwards on its own
 * when a wallet is disconnected in the extension or a session expires. See
 * `lib/onboarding`.
 *
 * Returns null once everything is done: an onboarding panel that never goes
 * away becomes furniture, and the space belongs to the game.
 */
export function GetStarted() {
  const mounted = useMounted();
  const { connected, wallets } = useWallet();
  const { status, signIn, error } = useAuth();
  const { openWalletModal } = useWalletConnect();
  const balance = useCustodyBalance();
  const authenticated = useSessionStore((state) => state.status === 'authenticated');
  const connectionError = useWalletStore((state) => state.connectionError);
  const program = useProgramDeployed();

  // Before mount the browser has not been asked what it has, so every answer
  // would differ between the server render and the first client render.
  const hasWallet =
    !mounted ||
    wallets.some((entry) => entry.readyState === 'Installed' || entry.readyState === 'Loadable');

  const state: OnboardingState = {
    hasWallet,
    connected,
    authenticated,
    spendableLamports: balance.data ? BigInt(balance.data.spendable) : null,
    cheapestEntryFee: cheapestPaidEntryFee(),
  };

  const active = currentStep(state);
  if (active === 'play') return null;

  const steps = buildSteps(state);

  return (
    <section
      data-testid="get-started"
      className="rounded-xl border border-slate-800 bg-slate-900/50 p-5"
    >
      <h2 className="text-lg font-semibold text-slate-100">Get started</h2>
      <p className="mt-1 text-sm text-slate-400">
        Four steps, all on Solana devnet with free test SOL. Nothing here uses real money.
      </p>

      <ol className="mt-4 space-y-3">
        {steps.map((step, index) => (
          <li key={step.id} className="flex gap-3">
            <span
              aria-hidden
              className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                step.status === 'done'
                  ? 'bg-emerald-500/20 text-emerald-300'
                  : step.status === 'current'
                    ? 'bg-sky-500/20 text-sky-300'
                    : 'bg-slate-800 text-slate-500'
              }`}
            >
              {step.status === 'done' ? '✓' : index + 1}
            </span>

            <div className="min-w-0 flex-1">
              <p
                className={`text-sm font-medium ${
                  step.status === 'upcoming' ? 'text-slate-500' : 'text-slate-100'
                }`}
              >
                {step.title}
              </p>

              {step.status === 'current' ? (
                <>
                  <p className="mt-0.5 text-sm text-slate-400">{step.description}</p>
                  <div className="mt-2">
                    <StepAction
                      step={step.id}
                      hasWallet={hasWallet}
                      authenticating={status === 'authenticating'}
                      onConnect={openWalletModal}
                      onSignIn={() => void signIn()}
                      depositsUnavailable={program.deployed === false}
                    />
                  </div>
                  {step.id === 'connect' && connectionError ? (
                    <p className="mt-2 text-xs text-amber-400">{connectionError}</p>
                  ) : null}
                  {step.id === 'sign-in' && error ? (
                    <p className="mt-2 text-xs text-rose-400">{error.message}</p>
                  ) : null}
                </>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function StepAction({
  step,
  hasWallet,
  authenticating,
  onConnect,
  onSignIn,
  depositsUnavailable,
}: {
  step: 'connect' | 'sign-in' | 'deposit' | 'play';
  hasWallet: boolean;
  authenticating: boolean;
  onConnect: () => void;
  onSignIn: () => void;
  depositsUnavailable: boolean;
}) {
  if (step === 'connect') {
    // No wallet means the picker can only offer something that cannot work.
    // Offering "Connect" anyway produces a modal, a click, and silence.
    return hasWallet ? (
      <Button size="sm" onClick={onConnect}>
        Connect wallet
      </Button>
    ) : (
      <a
        href="https://phantom.app/download"
        target="_blank"
        rel="noreferrer"
        className="inline-flex h-9 items-center rounded-lg bg-violet-600 px-3 text-sm font-medium text-white hover:bg-violet-500"
      >
        Install Phantom
      </a>
    );
  }

  if (step === 'sign-in') {
    return (
      <Button size="sm" onClick={onSignIn} loading={authenticating} disabled={authenticating}>
        {authenticating ? 'Waiting for signature…' : 'Sign in'}
      </Button>
    );
  }

  if (step === 'deposit') {
    // Telling someone to deposit when deposits cannot work is the same defect
    // as offering the button: it sends them to a form that will fail in their
    // wallet, and they will reasonably blame the wallet.
    if (depositsUnavailable) {
      return (
        <p className="text-xs text-amber-400/90">
          Deposits are unavailable right now — the arena program is not deployed on this cluster.
          The free room is playable in the meantime.
        </p>
      );
    }

    return (
      <p className="text-xs text-slate-500">
        Use the deposit panel below. You need at least{' '}
        <span className="text-slate-300">{formatSolShort(cheapestPaidEntryFee())} ◎</span> to enter
        the cheapest room, or play the free room for nothing.
      </p>
    );
  }

  return null;
}
