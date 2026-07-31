import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface SessionState {
  wallet: string | null;
  playerId: string | null;
  nickname: string;
  /** Access token is kept in memory only; see `partialize` below. */
  accessToken: string | null;
  status: 'anonymous' | 'authenticating' | 'authenticated';

  setNickname: (nickname: string) => void;
  beginAuth: () => void;
  completeAuth: (payload: { wallet: string; playerId: string; accessToken: string }) => void;
  signOut: () => void;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      wallet: null,
      playerId: null,
      nickname: '',
      accessToken: null,
      status: 'anonymous',

      setNickname: (nickname) => set({ nickname }),
      beginAuth: () => set({ status: 'authenticating' }),
      completeAuth: ({ wallet, playerId, accessToken }) =>
        set({ wallet, playerId, accessToken, status: 'authenticated' }),
      signOut: () => set({ wallet: null, playerId: null, accessToken: null, status: 'anonymous' }),
    }),
    {
      name: 'arena-session',
      // Only the nickname survives a reload. Persisting the access token to
      // localStorage would expose it to any XSS on the page; the refresh token
      // lives in an httpOnly cookie and re-mints it instead.
      partialize: (state) => ({ nickname: state.nickname }),
    },
  ),
);
