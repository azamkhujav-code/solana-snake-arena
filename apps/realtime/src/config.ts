import { getRealtimeEnv, type RealtimeEnv } from '@arena/env/server';

export type Config = RealtimeEnv;

export const config: Config = getRealtimeEnv();

/** Derived once so the tick loop never recomputes it. */
export const TICK_INTERVAL_MS = 1000 / config.TICK_RATE_HZ;
export const SNAPSHOT_INTERVAL_MS = 1000 / config.SNAPSHOT_RATE_HZ;

/** How many ticks pass between snapshots. */
export const TICKS_PER_SNAPSHOT = Math.max(
  1,
  Math.round(config.TICK_RATE_HZ / config.SNAPSHOT_RATE_HZ),
);
