# Scaling to 100,000 concurrent players

This document works through the capacity model and names the bottleneck at each
tier. Numbers are engineering estimates for planning, not measurements — the
scaffold has no implementation to benchmark yet. Validate them with a load test
before trusting them (see [Load testing](#load-testing)).

## Capacity model

Working from the target backwards:

```
100,000 concurrent players
  ÷ 120 players per room        =    834 rooms
  ÷  40 rooms per realtime node =     21 realtime nodes
```

With headroom for regional imbalance, failure domains and rolling deploys, plan
for roughly **30 realtime nodes at 1 vCPU each**, spread across regions.

The stateless tiers are sized by request rate rather than connection count:

| Tier       | Load driver                              | Estimate           |
| ---------- | ---------------------------------------- | ------------------ |
| web        | page loads, static assets (CDN-fronted)  | 4–8 replicas       |
| gateway    | auth + profile + leaderboard reads       | 10–20 replicas     |
| matchmaker | one placement per join, ~2k joins/sec    | 4–6 replicas       |
| Redis      | registry, presence, tickets, leaderboard | 3-node cluster     |
| Postgres   | async match writes, profile reads        | 1 primary + 2 read |

## Bottleneck analysis

### 1. Bandwidth — the binding constraint

This is what actually decides whether the design works.

Naive broadcast is O(players²) per room: every player receives every other
player's state. At 120 players, 15 Hz, and ~200 bytes per snake as JSON, that is
roughly **43 MB/s per room** — about 36 Gbit/s across 834 rooms. Not viable.

Two mitigations, applied together:

**Area-of-interest filtering.** A client only receives entities inside
`AOI_RADIUS`. Visible entity count is bounded by view area and density, not by
room population, so per-player bandwidth stops growing once the room is dense
enough to fill a screen. Expect ~20–30 visible snakes instead of 119.

**Binary encoding.** Positions quantise to `i16` relative to the viewer
(`POSITION_SCALE = 4`, so 0.25-unit precision — well below render resolution),
angles to `u16`. A snake record drops from ~200 bytes of JSON to ~20–40 bytes
packed.

Together: roughly **150–250 KB/s per player down**, ~2 KB/s up. At 100k players
that is on the order of 20 Gbit/s egress — real money, and the reason snapshot
size is treated as a first-class metric (`arena_snapshot_bytes_total`) rather
than an afterthought.

> Both numbers above are estimates. Measure `arena_snapshot_bytes_total ÷
connected players` under load before committing to an egress budget.

### 2. CPU — the tick loop

Each node runs one fixed-timestep loop over all its rooms. At 30 Hz the budget is
**33 ms per tick for every room on the node**. With 40 rooms that is well under
1 ms per room, which is why the collision broad-phase has to be a spatial hash
rather than pairwise checks.

Node.js runs one event loop per process, so a realtime pod gets exactly 1 vCPU.
Giving it four cores does not make the loop faster; it just wastes three cores.
Scale by adding processes.

Consequences that follow from the 33 ms budget:

- Spatial hash for both collision and AOI — pairwise is O(n²) and blows the budget.
- Pooled buffers for snapshot encoding — per-player-per-tick allocation turns
  into GC pauses, and a GC pause _is_ a missed tick.
- Pooled sprites and typed arrays in the simulation — same reason.
- No `await` inside the tick loop. Any IO in the loop couples frame time to
  network latency.

### 3. Redis — coordination only

Redis handles the node registry, presence, tickets, rate limits and leaderboards.
Sizing at 100k players:

- Heartbeats: 30 nodes ÷ 5 s = **6 ops/sec**
- Placements: ~2,000 joins/sec ≈ **6,000 ops/sec**
- Leaderboard writes: batched per room per second ≈ **1,000 ops/sec**

Comfortably within a single node's capability; Cluster is for availability and
headroom, not throughput.

Game snapshots deliberately do **not** go through Redis. Routing 15 Hz × 100k
players through pub/sub would be ~1.5M messages/sec and would make Redis the
bottleneck long before the game servers saturated. The Socket.IO Redis adapter
is present for operator broadcasts and drain signalling only.

Keys that participate in multi-key operations carry a `{hash tag}` so they stay
on one slot when the single node becomes a cluster.

### 4. Postgres — off the hot path

Nothing in the tick loop touches the database. Writes happen when a match ends:
~2,000 matches/sec × ~10 participant rows ≈ **20k row inserts/sec**, batched.

The real risk is connection exhaustion, not throughput. Prisma opens a pool per
process; 20 gateway replicas × 10 connections is already 200, and Postgres
defaults to 100. Hence PgBouncer in transaction-pooling mode, with
`DIRECT_DATABASE_URL` reserved for migrations, which need session-level features
that transaction pooling does not support.

`matches` and `match_participants` are append-only and are the tables that will
need range partitioning by `started_at` once volume justifies it. Reads go to
replicas.

### 5. Connection handling

100k WebSockets is roughly 3,300 per realtime node. That needs:

- `worker_rlimit_nofile` raised at the proxy (see `infra/nginx/nginx.conf`) —
  the default 1024 caps a node far below its real capacity.
- WebSocket transport only. Long-polling doubles connection count and defeats
  the binary path.
- `perMessageDeflate: false`. Snapshots are already packed; a second compression
  pass costs CPU on the tick thread for almost no gain.

## Autoscaling

Scale realtime on **tick headroom**, not CPU and not connection count:

```
saturation = p95(arena_tick_duration_seconds) / (1 / TICK_RATE_HZ)
```

Scale out above ~0.7, scale in below ~0.3 with a long stabilisation window. A
node can sit at 40% CPU and still miss its budget because one room got dense;
it can also sit at 80% CPU and be perfectly healthy. Only tick duration tracks
whether the node can accept another room.

Gateway, matchmaker and web scale on ordinary CPU/RPS targets.

## Placement strategy

Default is **best-fit**, not least-loaded.

Least-loaded spreads players evenly. That sounds fair, but it leaves every room
half-empty — bad for gameplay, since a sparse arena is boring — and every node
partly loaded, so nothing can ever be scaled down. Best-fit packs rooms to
`ROOM_TARGET_FILL_RATIO` before opening new ones, keeping games dense and empty
nodes reclaimable.

`region-affinity` exists for latency-sensitive modes where a player should stay
in-region even at the cost of a thinner room.

## Failure domains

| Failure             | Blast radius            | Recovery                                                                     |
| ------------------- | ----------------------- | ---------------------------------------------------------------------------- |
| One realtime node   | ~4,800 players in-match | Clients re-matchmake; heartbeat expires and the node stops receiving players |
| One gateway replica | in-flight requests      | LB removes it on readiness failure                                           |
| Redis primary       | new joins stall         | Cluster failover; running games continue, since they hold state in memory    |
| Postgres primary    | no match persistence    | Games keep running; writes queue and replay                                  |

Running games surviving a Postgres outage is not accidental — it follows
directly from keeping the database off the hot path.

## Load testing

The estimates above need validation before launch. Priority order:

1. **Single room saturation** — one node, one room, ramp to 120 players.
   Measure tick duration and snapshot bytes per player. This validates the two
   numbers everything else is derived from.
2. **Single node saturation** — ramp rooms to 40 and confirm tick p95 stays
   inside budget.
3. **Placement throughput** — hammer the matchmaker to confirm Redis op counts
   match the model.
4. **Drain under load** — SIGTERM a loaded node and confirm players migrate
   without a reconnect storm.

TODO: author the load-test harness under `scripts/load/`.
