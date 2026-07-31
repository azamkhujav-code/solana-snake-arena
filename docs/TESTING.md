# Testing

Seven layers, **767 tests, all executable locally with no external services**.

| Layer                | Count | Command              | Runs against                                  |
| -------------------- | ----- | -------------------- | --------------------------------------------- |
| Unit                 | 660   | `pnpm test`          | Pure functions and classes                    |
| Integration (schema) | 17    | `pnpm test`          | Real Postgres via PGlite (WASM)               |
| Integration (HTTP)   | 23    | `pnpm test`          | Real Fastify app via `inject`                 |
| Multiplayer          | 28    | `pnpm test`          | Real Socket.IO over a real port               |
| Smart contract       | 26    | `pnpm test:contract` | `cargo test`                                  |
| Load                 | 6     | `pnpm test:load`     | In-process simulation, real timings           |
| E2E                  | 26    | `pnpm test:e2e`      | Real Chromium + Pixel 7, real Next build      |
| Docs                 | 11    | `pnpm docs:check`    | The repo itself — links, env, schema, program |

`pnpm test:all` runs everything.

## The rule these follow

**Substitute only what genuinely needs a network.** Everything else runs for
real, because the bugs worth catching live in the seams a mock papers over.

Two bugs found this turn make the point, and neither was reachable by a unit
test:

- The error handler never checked `hasZodFastifySchemaValidationErrors`, so
  every route-schema rejection escaped as `FST_ERR_VALIDATION` with no `details`
  — clients were told their request was invalid but not which field. Both halves
  typecheck; only a real request reveals they disagree.
- `Room.addPlayer` on an unstarted room threw `Cannot read properties of
undefined (reading 'playerIndex')`. Now it names the invariant.

## Integration: real Postgres, in process

`packages/db/src/testing/pglite.ts` boots Postgres compiled to WASM and
**executes the migration history** rather than pushing the schema. Same planner,
same type system, same constraint enforcement — and a migration that is valid
Prisma but invalid SQL fails here instead of in a deploy. Startup is ~1s for the
whole file.

This is how `window` being a reserved word was caught originally, and there is
now a test pinning it. Others assert what the schema guarantees and the
application deliberately does not re-check:

- A duplicate `idempotency_key` is rejected by a unique index, not an `if` —
  which is why two concurrent retries cannot both pass a check and both insert.
- `bigint` survives 9,007,199,254,740,993 intact. A driver returning JS numbers
  would round it, and a rounded ledger is worse than none.
- Deleting a user nulls their transactions rather than cascading. Financial
  history has to outlive the account.
- Deleting a pool account with entries is refused outright.

One assertion had to change: PGlite returns `count(*)` as a number where
node-postgres returns a string. Casting to `::text` makes it driver-independent.

## Multiplayer: real sockets

`apps/realtime/src/testing/harness.ts` binds an ephemeral port and runs the real
middleware chain and handlers. Only Redis is substituted, by a Map with genuine
`GETDEL` semantics — which is the whole single-use ticket guarantee, so faking
it as read-then-delete would test nothing.

Covered: ticket forgery, wrong secret, expiry, wrong node, single-use
consumption, protocol mismatch, room isolation, chat fan-out and cross-room
leakage, malformed payloads, input floods, the disconnect grace window,
reconnect, and connection-burst throttling.

The harness buffers events **from socket creation**, not from when a test asks.
The server emits `Joined` the instant the handshake completes, which routinely
lands before a listener attaches — a race that presents as intermittent timeouts
and gets written off as flakiness.

## Smart contract

`cargo test` runs 26 tests with no validator. The account plumbing — ownership,
discriminators, PDA derivation — genuinely needs a runtime; the _arithmetic_
does not, and arithmetic is where a wrong answer silently pays the wrong amount
rather than failing loudly.

`settlement_math.rs` was extracted from `instructions/settle.rs` for this, and
**the instruction now calls it**. Testing a parallel implementation would be
worse than no test at all.

What it pins: payouts must sum exactly to the prize pool (a compromised backend
can misallocate a pot, but cannot mint or skim), rake rounds **down** so the
remainder stays with players, the fee cap is re-checked rather than trusted from
config, and every overflow is reported instead of wrapping.

`programs/tests/arena.test.ts` holds the Anchor integration suite. It needs
`solana-test-validator` and is **not** run here.

## Load

Not "requests per second" — the question for this system is whether a tick
finishes inside its 33ms budget. A room that overruns does not fail; it runs
slow, every player sees rubber-banding, and nothing in the logs says why.

Measured on this machine:

| Scenario                       | Per tick                  | Budget used |
| ------------------------------ | ------------------------- | ----------- |
| 120 players, one room          | 1.34ms                    | 4.0%        |
| 30 → 120 players               | 2.09x cost for 4x players | sub-linear  |
| **40 rooms × 30 players**      | **24.2ms**                | **72.5%**   |
| Spatial hash, 1k → 20k entries | 0.27µs → 0.44µs           | —           |

**The third row is the finding.** `MAX_ROOMS_PER_NODE=40` at 30 players each
leaves ~27% headroom on an unloaded dev machine — before Socket.IO
serialisation, snapshot fan-out, or anything else sharing the event loop. The
default is optimistic; treat it as a ceiling to measure against real hardware,
not a target.

Thresholds are deliberately loose. CI is slower and noisier than production, so
a tight bound fails for reasons unrelated to the code. What these catch is a
change of _complexity_ — an accidental O(n²) collision pass shows up as an order
of magnitude, which survives any amount of noise.

`tests/load/gateway.k6.js` and `tests/load/realtime-soak.mjs` target a deployed
stack and are not run in CI. Both are shaped around the real traffic pattern:
continuous lobby polling plus a burst every ten minutes when the match cycle
turns over. A flat arrival rate would report a healthy p95 and say nothing about
the only moment that has ever been a problem.

## E2E

Real Chromium and a Pixel 7 viewport, against `next start` on the production
build — not `next dev`, which has different error handling and hydration and so
tests something users never run.

**The gateway is not running**, and that is the point. "The API is down" is a
state real users hit, and a client that renders blank, spins forever, or throws
an unhandled rejection is broken in a way no unit test sees, because unit tests
resolve their mocks. Every page must render, navigate client-side, degrade
honestly, and never scroll the body horizontally on mobile.

Backend-dependent tests are tagged `@backend` and skipped unless
`E2E_BACKEND=1`, so the coverage exists the moment someone runs
`docker compose up` rather than being deleted.

## Documentation

`scripts/docs.test.ts` pins the doc claims that are mechanically checkable:
every relative link resolves, every Mermaid diagram parses with the real parser,
every env var in a schema appears in `.env.example` and vice versa, every
workspace package appears in the README, every `pnpm` script referenced exists,
and every program instruction, PDA seed and database table is documented.

It deliberately does **not** check prose. A test asserting a paragraph is
accurate is a test asserting a string has not changed — it fails on every edit
and gets deleted within a month.

Mermaid parsing runs out of process (`scripts/check-mermaid.mjs`) because the
sanitiser needs a `window` installed before the module evaluates. Diagrams
without a `<br/>` parse without one, so the gap only shows up on exactly the
diagrams worth having.

This found real drift on its first run: `WORKER_CONCURRENCY` and
`WORKER_SCHEDULER_ENABLED` were documented but read from a schema living outside
`packages/env`, which meant `pnpm env:check` never validated the worker at all —
the one process that signs settlement transactions.

## What is still not tested

- **Anchor on-chain behaviour.** No validator here; the program has never been
  built for SBF or executed. `settlement_math` is unit tested, the instruction
  wrappers are not.
- **Redis.** Substituted everywhere. The Lua CAS in the lobby store and the
  BullMQ queue paths are unexercised.
- **The web app against a live API.** All 26 E2E tests run backendless.
- **PixiJS rendering.** The canvas is instantiated in E2E but nothing asserts
  what is drawn.
- **Multi-node behaviour.** One realtime node per test; the Redis adapter,
  cross-node broadcast and drain/migrate paths are untested.
