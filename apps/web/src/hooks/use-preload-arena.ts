'use client';

import { useEffect } from 'react';

/**
 * Downloads the renderer while the player is still choosing a room.
 *
 * The arena is a dynamic import, so PixiJS and the game canvas live in their
 * own chunks — correct, since the lobby has no use for a WebGL engine. But it
 * means nothing starts fetching them until the click, and they are the largest
 * chunks in the app: measured from the room board, the click landed at 56ms and
 * those chunks did not begin arriving until 728ms. Almost the entire wait
 * between pressing play and seeing the arena was a download that could have
 * happened while the player was reading the room list.
 *
 * Deliberately fired on idle rather than on mount. A player who opens the board
 * and immediately clicks should not have their match competing with a prefetch
 * for bandwidth, and someone who never plays should not pay for the engine at
 * all — `requestIdleCallback` waits for a gap in the work.
 *
 * The import result is discarded: this exists for its side effect on the module
 * cache. When the real import runs it resolves from memory.
 */
export function usePreloadArena(): void {
  useEffect(() => {
    let cancelled = false;

    const warm = (): void => {
      if (cancelled) return;
      // Failure is silent and harmless: the real import will simply pay the
      // download cost it would have paid anyway.
      void import('@/components/game/GameCanvas').catch(() => undefined);
    };

    // Safari has no `requestIdleCallback`; a short timeout is close enough for
    // something whose only job is "not right this second". Typed as optional
    // because the DOM lib declares it unconditionally and the runtime does not.
    const idle = (window as { requestIdleCallback?: typeof window.requestIdleCallback })
      .requestIdleCallback;

    if (idle) {
      const handle = idle(warm, { timeout: 3_000 });
      return () => {
        cancelled = true;
        window.cancelIdleCallback?.(handle);
      };
    }

    const handle = window.setTimeout(warm, 1_500);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, []);
}
