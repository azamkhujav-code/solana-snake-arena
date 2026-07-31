import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type QualityPreset = 'low' | 'medium' | 'high';

export interface SettingsState {
  quality: QualityPreset;
  showMinimap: boolean;
  showDebugOverlay: boolean;
  masterVolume: number;
  /** Client-side prediction can be disabled to diagnose desync reports. */
  predictionEnabled: boolean;

  setQuality: (quality: QualityPreset) => void;
  toggleMinimap: () => void;
  toggleDebugOverlay: () => void;
  setMasterVolume: (volume: number) => void;
  setPredictionEnabled: (enabled: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      quality: 'high',
      showMinimap: true,
      showDebugOverlay: false,
      masterVolume: 0.6,
      predictionEnabled: true,

      setQuality: (quality) => set({ quality }),
      toggleMinimap: () => set((state) => ({ showMinimap: !state.showMinimap })),
      toggleDebugOverlay: () => set((state) => ({ showDebugOverlay: !state.showDebugOverlay })),
      setMasterVolume: (masterVolume) => set({ masterVolume }),
      setPredictionEnabled: (predictionEnabled) => set({ predictionEnabled }),
    }),
    { name: 'arena-settings' },
  ),
);
