'use client';

import { useSyncExternalStore } from 'react';

/**
 * `false` during SSR and on the first client render, `true` afterwards.
 *
 * The narrow purpose: gating UI that depends on something only the browser can
 * know. Wallet detection is the case here — whether an extension is present, and
 * whether a mobile wallet can be deep-linked, are answerable only on the client,
 * and the answer depends on the user agent.
 *
 * Rendering that answer directly is a hydration mismatch. The server has no
 * wallet, so it emits the "no wallet" branch; the client may immediately have
 * one, so it emits the other. React finds two different elements in the same
 * slot, discards the server tree, and logs an error — and the discarded subtree
 * takes any focus or scroll position with it.
 *
 * Reading the flag before mount and rendering the *server's* branch makes the
 * two agree. The real state arrives one paint later, which for a fallback path
 * is imperceptible and is the price of hydrating cleanly.
 *
 * This is not a general-purpose escape hatch. Gating a whole page on it throws
 * away server rendering entirely; it belongs only around the specific element
 * whose content the server genuinely cannot know.
 *
 * Implemented with `useSyncExternalStore` rather than the more familiar
 * `useState(false)` plus an effect that sets it to `true`. That version works,
 * but it makes every consumer render twice and sets state during an effect,
 * which risks a cascading render. `useSyncExternalStore` takes a *separate*
 * server snapshot, which is precisely this problem: React reads `false` while
 * rendering on the server and during hydration, then `true`, with no extra
 * render pass and no state write.
 */

/**
 * Never fires, so React never re-reads the snapshot.
 *
 * Module-level so the reference is stable. An inline closure would be a new
 * function on every render, and `useSyncExternalStore` resubscribes whenever
 * `subscribe` changes — an unsubscribe/resubscribe pair per render.
 */
const subscribe = (): (() => void) => () => undefined;

export function useMounted(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true, // client
    () => false, // server, and therefore also the hydration pass
  );
}
