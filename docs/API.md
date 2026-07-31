# REST API

Two services expose HTTP. They are documented separately because they are
deployed separately.

| Service    | Port | Docs                         | Spec                                 |
| ---------- | ---- | ---------------------------- | ------------------------------------ |
| Gateway    | 4000 | <http://localhost:4000/docs> | <http://localhost:4000/openapi.json> |
| Matchmaker | 4002 | <http://localhost:4002/docs> | <http://localhost:4002/openapi.json> |

The interactive UI is **development only**. In production the JSON is still
served — client generators need it — but an interactive console pointed at a
live custody API is not something to ship.

## Why the split

| Concern                                                           | Service    | Backing store |
| ----------------------------------------------------------------- | ---------- | ------------- |
| Who is queued right now, countdown, join, leave                   | Matchmaker | Redis         |
| Room configuration, completed games, ledger, rewards, leaderboard | Gateway    | Postgres      |

Lobby state changes on every join and is polled by every browser sitting in the
menu. Writing that to Postgres would put the busiest path in the product on the
slowest store. The gateway, by contrast, serves durable records that change once
per match.

The practical consequence for a client: `GET /v1/rooms` on the gateway returns
the seven arena _configurations_; `GET /v1/lobbies` on the matchmaker returns
what is actually happening in them.

## Endpoints

### Gateway

| Group           | Endpoints                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| **auth**        | `POST /v1/auth/nonce`, `/verify`, `/refresh`, `/logout`; `GET /v1/auth/me`                                |
| **wallet**      | `GET /v1/wallet/balance`, `GET /v1/wallet/transactions`                                                   |
| **deposits**    | `POST /v1/wallet/deposits`, `POST /v1/wallet/deposits/confirm`                                            |
| **withdrawals** | `POST /v1/wallet/withdrawals/quote`, `POST /v1/wallet/withdrawals`, `POST /v1/wallet/withdrawals/confirm` |
| **rooms**       | `GET /v1/rooms`, `/v1/rooms/{roomId}`, `/v1/rooms/{roomId}/games`                                         |
| **games**       | `GET /v1/games`, `/v1/games/{gameId}`                                                                     |
| **history**     | `GET /v1/history`                                                                                         |
| **rewards**     | `GET /v1/rewards`, `/v1/rewards/{rewardId}`; `POST /v1/rewards/{rewardId}/claim`                          |
| **leaderboard** | `GET /v1/leaderboard`, `/v1/leaderboard/me`                                                               |
| **players**     | `GET /v1/players/{playerId}`, `/stats`; `PATCH /v1/players/me`                                            |
| **admin**       | 19 operations under `/v1/admin` — see [ADMIN.md](ADMIN.md)                                                |

Everything under `/v1/admin` requires `MODERATOR` (read) or `ADMIN` (write) and
is guarded by a hook on the whole scope rather than per route — see
[ADMIN.md](ADMIN.md) for why that distinction matters.

`GET /v1/players/me/matches` still works as a deprecated alias for
`/v1/history`. It is documented rather than redirected: a 3xx on an
authenticated XHR is a worse failure mode than a name that lingers.

### Matchmaker

| Group           | Endpoints                                                                              |
| --------------- | -------------------------------------------------------------------------------------- |
| **lobbies**     | `GET /v1/lobbies`, `/v1/lobbies/{tierId}`; `POST /v1/lobbies/join`, `/leave`, `/ready` |
| **matchmaking** | `POST /v1/matchmake`; `GET /v1/servers`                                                |

## Conventions

**Amounts are strings.** Every lamport value crosses the wire as a decimal
string. Above roughly 9M SOL a lamport count exceeds `Number.MAX_SAFE_INTEGER`,
and JSON has no bigint — a client that parses these as numbers corrupts balances
silently, which is the worst way for a money bug to behave.

**Pagination is keyset.** Pass the `nextCursor` from a response as `cursor` on
the next request. `OFFSET` is not offered: on the ledger and match-history
tables it degrades from an index seek to a scan as the offset grows.

**Errors share one envelope.**

```json
{
  "error": {
    "code": "INSUFFICIENT_BALANCE",
    "message": "Not enough spendable balance",
    "details": null,
    "requestId": "req-01H..."
  }
}
```

Branch on `code` — it is stable. `message` is prose and may be reworded.
`requestId` appears on every response and is what ties a user's report to a log
line.

**Two-step money flows.** Deposits and withdrawals are intent-then-confirm. The
intent reserves a record and returns what to sign; no funds move until the
signature comes back. Confirmation is idempotent — keyed on the signature by a
unique constraint, so a retry after a dropped response cannot double-credit.

**Authentication is wallet-signature based.** `POST /v1/auth/nonce` returns a
message; the wallet signs it verbatim; `POST /v1/auth/verify` exchanges the
signature for an access/refresh pair. Access tokens are short-lived and refresh
tokens are single-use — see [SECURITY.md](SECURITY.md) and the sign-in sequence
in [SEQUENCES.md](SEQUENCES.md).

**Not-yet-implemented endpoints are marked.** A few operations still respond
`501` and their descriptions say so. They are in the spec because the contract
is settled even where the handler is not, and a client generated today will not
need regenerating when they land. As of now: `POST /v1/internal/rooms` on the
matchmaker, and `GET /v1/matches/{matchId}` / `PATCH /v1/players/me` /
`GET /v1/players/{playerId}` on the gateway.

## Generating the spec

The document is generated from the same Zod schemas Fastify validates with, via
`fastify-type-provider-zod`'s `jsonSchemaTransform`. Nothing is hand-written, so
the spec cannot describe a contract the server does not enforce — the usual
failure of a hand-maintained OpenAPI file is that it drifts, and a drifted spec
is worse than none because clients trust it.

```bash
pnpm openapi   # writes docs/api/{gateway,matchmaker}.openapi.json
```

The script boots each app and asks it for its document, so **Postgres and Redis
must be running** (`pnpm docker:up`). Both services also serve their own spec
live at `/openapi.json`, which is usually the easier source during development.

CI does not run the script — it needs a stack. What can actually break is
covered instead by `plugins/swagger.test.ts` in each service, which builds the
document with stubbed decorators and asserts that every route converts, every
operation is tagged and summarised, and lamport fields are typed as strings. A
schema Zod accepts but the JSON Schema converter rejects fails at _boot_, so
without that test the first sign of it would be a crashed deploy.

Error responses (400/401/404/429/500) are attached centrally in each service's
`plugins/swagger.ts` rather than repeated on every route — repeated, they would
be copied inconsistently and the copies would rot. Which codes apply is derived
from the route: no input schema means no 400, no `security` means no 401, no
path parameter means no 404.
