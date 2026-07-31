# Operations

## Deploying

Order matters, because realtime nodes drain slowly and old code runs alongside
new code for the duration:

```
1. Run migrations (expand only — additive, backwards-compatible)
2. Deploy gateway + matchmaker  (stateless, fast rollout)
3. Deploy realtime              (rolling, drain-aware, slow by design)
4. Deploy web
5. Run contract migrations (drop columns) — next release, never this one
```

### Expand/contract migrations

A realtime node can take minutes to drain. During that window the previous
release is still running against the new schema. So:

- **Expand now:** add nullable columns, add tables, add indexes concurrently.
- **Contract later:** drop columns and constraints in a _subsequent_ release,
  once no old code remains.

Renaming a column in place breaks the running fleet.

## Draining a realtime node

Triggered by SIGTERM. The order is load-bearing:

```
1. Deregister from the matchmaker      ← stop new placements FIRST
2. Fail /health/ready                  ← LB stops new upgrades
3. Emit Migrate to connected clients   ← they re-matchmake elsewhere
4. Wait for rooms to empty, up to DRAIN_TIMEOUT_SECONDS
5. Stop the tick loop, close sockets, exit
```

Reversing steps 1 and 3 dumps every player into a reconnect storm aimed at a node
that is still advertised as healthy — they get placed right back onto the node
that is shutting down.

`terminationGracePeriodSeconds` must exceed `DRAIN_TIMEOUT_SECONDS` plus a
margin, or the kubelet SIGKILLs mid-drain.

## Health endpoints

| Endpoint        | Checks                       | Used by          |
| --------------- | ---------------------------- | ---------------- |
| `/health/live`  | process responsive           | kubelet liveness |
| `/health/ready` | Redis, Postgres, drain state | LB / readiness   |

Liveness deliberately does **not** touch downstream systems. If it did, a Redis
blip would fail liveness across the entire fleet simultaneously and restart every
pod at once — turning a degraded dependency into a full outage.

## Key metrics

| Metric                                 | Watch for                                 |
| -------------------------------------- | ----------------------------------------- |
| `arena_tick_duration_seconds` p95      | > 70% of tick budget → scale out          |
| `arena_tick_lag_ms`                    | sustained > 0 → node is underwater        |
| `arena_snapshot_bytes_total` / players | egress regression after a protocol change |
| `arena_inputs_dropped_total`           | spike → cheating or a client bug          |
| `arena_rooms_active`                   | vs `MAX_ROOMS_PER_NODE`                   |
| `http_request_duration_seconds`        | gateway p99                               |

## Suggested alerts

TODO: encode these as Prometheus rules under `infra/prometheus/rules/`.

- **Tick budget exceeded** — p95 tick duration > 70% of budget for 5 min.
- **Node capacity** — `arena_rooms_active / MAX_ROOMS_PER_NODE` > 0.9.
- **Placement failures** — matchmaker 5xx rate > 1%.
- **Settlement backlog** — `settlements` rows in `PENDING` older than 10 min.
- **Auth anomaly** — `/auth/verify` failure ratio > 50% over 5 min.

## Runbooks

### Realtime node is missing ticks

1. Check `arena_rooms_active` — is it over the configured cap?
2. Check `arena_tick_duration_seconds` by room, if the label is present.
3. A single dense room can blow the budget alone. Confirm `MAX_PLAYERS_PER_ROOM`
   is being honoured.
4. Short term: drain the node and let the matchmaker redistribute.
5. Longer term: lower `MAX_ROOMS_PER_NODE` and scale out.

### Players cannot join

1. Is the matchmaker healthy? Check `/health/ready`.
2. Is the node registry populated? `SMEMBERS arena:cluster:nodes`.
3. Have heartbeats expired? Realtime nodes healthy but unregistered means the
   heartbeat loop died — check realtime logs for Redis errors.
4. Is every node at capacity? Scale out.

### Settlement is stuck

1. Query `settlements` where `status = 'PENDING'` or `'FAILED'`.
2. Check `lastError` and `attempts`.
3. Devnet RPC rate limits are a common cause — check the RPC endpoint's health
   before assuming a program bug.
4. Retries are safe: settlement is idempotent on `idempotencyKey`.

## Backups

TODO: define retention and restore-test cadence.

- Postgres: PITR, tested restore monthly.
- Redis: coordination data is reconstructible; a lost Redis costs in-flight
  placements, not durable state. Leaderboard windows should be periodically
  reconciled from Postgres.
