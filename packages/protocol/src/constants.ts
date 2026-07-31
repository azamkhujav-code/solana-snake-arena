/**
 * Constants that both the client predictor and the server simulation must agree
 * on exactly. A divergence here shows up as rubber-banding, so this file is the
 * single source of truth and is never overridden per-environment.
 */

/** World is a circle; players bounce off / die at the boundary. */
export const WORLD_RADIUS = 8_000;

/** Simulation steps per second on the server. */
export const DEFAULT_TICK_RATE_HZ = 30;

/** Snapshots per second pushed to clients. Interpolation covers the gap. */
export const DEFAULT_SNAPSHOT_RATE_HZ = 15;

/** Fixed timestep in ms, derived so client and server round identically. */
export const FIXED_TIMESTEP_MS = 1000 / DEFAULT_TICK_RATE_HZ;

/* ---- Snake tuning ------------------------------------------------------ */

export const BASE_SPEED = 220;
export const BOOST_SPEED_MULTIPLIER = 1.9;
/** Mass drained per second while boosting. */
export const BOOST_MASS_DRAIN_PER_SECOND = 4;
export const MIN_BOOST_MASS = 20;
export const STARTING_MASS = 10;
export const MAX_TURN_RATE_RAD_PER_SEC = 4.2;
/** Distance between recorded spine points. */
export const SEGMENT_SPACING = 12;

/* ---- Food -------------------------------------------------------------- */

export const FOOD_MASS_MIN = 1;
export const FOOD_MASS_MAX = 6;
export const TARGET_FOOD_DENSITY_PER_1000_SQ = 3;

/* ---- Networking -------------------------------------------------------- */

/**
 * Area-of-interest radius. A client is only sent entities inside this radius,
 * which is what keeps per-player bandwidth flat as the room fills.
 */
export const AOI_RADIUS = 1_400;

/** Spatial hash cell size used for both collision and AOI queries. */
export const SPATIAL_CELL_SIZE = 512;

/** Client renders this far behind server time to hide jitter. */
export const INTERPOLATION_DELAY_MS = 100;

/** Inputs are batched into one packet at this rate. */
export const INPUT_SEND_RATE_HZ = 20;

/** Server drops a connection that misses this many consecutive heartbeats. */
export const HEARTBEAT_INTERVAL_MS = 5_000;
export const HEARTBEAT_TIMEOUT_MS = 20_000;

/** Hard ceiling on a single client->server packet. */
export const MAX_PACKET_BYTES = 4_096;

/* ---- Room sizing ------------------------------------------------------- */

export const DEFAULT_MAX_PLAYERS_PER_ROOM = 120;
export const MIN_PLAYERS_TO_KEEP_ROOM_OPEN = 1;

/** Bots keep a thin room feeling populated; capped so CPU stays predictable. */
export const MAX_BOTS_PER_ROOM = 20;
