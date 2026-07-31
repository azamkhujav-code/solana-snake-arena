import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

import { config } from './config.js';

export const registry = new Registry();
registry.setDefaultLabels({
  service: config.SERVICE_NAME,
  node_id: config.NODE_ID,
  region: config.DEPLOY_REGION,
});

if (config.METRICS_ENABLED) {
  collectDefaultMetrics({ register: registry });
}

/**
 * The autoscaling signal.
 *
 * Player count alone is misleading — a node can be at half its player cap and
 * already missing frames. Tick duration against the budget is what actually
 * determines whether this node can take another room.
 */
export const tickDuration = new Histogram({
  name: 'arena_tick_duration_seconds',
  help: 'Wall time to simulate one tick across all rooms on this node',
  buckets: [0.001, 0.002, 0.005, 0.01, 0.016, 0.025, 0.033, 0.05, 0.1],
  registers: [registry],
});

export const tickLag = new Gauge({
  name: 'arena_tick_lag_ms',
  help: 'How far behind schedule the fixed-timestep loop is running',
  registers: [registry],
});

export const roomsGauge = new Gauge({
  name: 'arena_rooms_active',
  help: 'Rooms currently hosted by this node',
  registers: [registry],
});

export const playersGauge = new Gauge({
  name: 'arena_players_connected',
  help: 'Players connected to this node',
  registers: [registry],
});

export const snapshotBytes = new Counter({
  name: 'arena_snapshot_bytes_total',
  help: 'Total bytes of snapshot payload emitted',
  registers: [registry],
});

export const droppedInputs = new Counter({
  name: 'arena_inputs_dropped_total',
  help: 'Input packets rejected',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const socketEvents = new Counter({
  name: 'arena_socket_events_total',
  help: 'Socket lifecycle events',
  labelNames: ['event'] as const,
  registers: [registry],
});
