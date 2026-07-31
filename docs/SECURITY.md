# Security

Nine layers. Sections 1–3 and 6–9 describe code that now exists; the on-chain
trust model and logging sections below are unchanged.

## 1. Wallet signature verification

There is no password. Identity is a Solana wallet, proven by an ed25519
signature over a server-issued nonce. On Solana the address **is** the public
key, so verification needs no key lookup.

```
1. POST /v1/auth/nonce { wallet }
   -> nonce stored in Redis, 5-minute TTL
   -> returns the exact message to sign (buildAuthMessage)

2. wallet signMessage(message)

3. POST /v1/auth/verify { wallet, signature, nonce }
   -> GETDEL the nonce (consumed exactly once)
   -> rebuild the message from stored fields, verify the signature
   -> upsert player, issue access + refresh
```

- **The server rebuilds the message from its own stored nonce.** It never
  verifies a client-supplied string — otherwise a caller signs `"hello"` and
  presents it as proof of anything.
- **One shared `buildAuthMessage()`** in `@arena/solana`, used by both sides. Two
  implementations drift by a newline, and "valid signature rejected" is a
  miserable failure to chase.
- **`signMessage`, not a transaction.** Costs nothing, needs no RPC round trip,
  and cannot be replayed as an on-chain action.
- **Domain and expiry are inside the signed message**, so a signature captured on
  one site or at one moment cannot be reused elsewhere or later.
- `verifySignature` returns false rather than throwing on a malformed key or
  signature. Length is checked before `tweetnacl`, which throws on wrong-sized
  input — and a throw would turn a bad request into a 500.

## 2. Replay attack prevention

Four mechanisms, covering different replays.

**Nonces are consumed with `GETDEL`.** Atomic. A GET-then-DEL pair lets two
concurrent requests both observe the nonce as unused — the exact race the nonce
exists to prevent, and the kind that only appears under load. A test runs two
consumers concurrently and asserts exactly one wins.

**The nonce is consumed before the signature is checked**, so a failed attempt
still burns it. Otherwise an attacker with a captured message brute-forces
against a nonce that lives for its full five minutes.

**One outstanding challenge per wallet.** A second nonce overwrites the first,
bounding an attacker to one rather than letting them farm a pile.

**Refresh tokens are single-use, and reuse is treated as theft.** An
already-rotated token means two parties hold it and there is no way to tell
which is the owner, so the whole family is revoked. Logging a user out is a much
cheaper mistake than leaving a thief with a live session.

## 3. JWT

| Token   | Lifetime        | Client storage            | Server storage           | Revocation                     |
| ------- | --------------- | ------------------------- | ------------------------ | ------------------------------ |
| Access  | 900s            | memory only               | —                        | jti denylist + per-user cutoff |
| Refresh | 30d, single-use | `httpOnly` cookie         | SHA-256 hash in Postgres | family revocation              |
| Ticket  | 30s             | passed in the handshake   | —                        | single-use via Redis           |

`iss` and `aud` are pinned to `AUTH_DOMAIN`, so a token minted for staging
cannot be replayed against production.

The access token is never written to `localStorage` — anything there is readable
by any XSS on the page, and a stolen access token is a full account takeover.
The Zustand session store's `partialize` persists only the nickname.

### Why the refresh token is a cookie and the access token is not

Memory-only storage means a page reload starts anonymous. Left there, every
refresh demands another wallet signature, which is bad enough that the usual
"fix" is to persist a token in `localStorage` — undoing the protection above.

Instead the refresh token goes in an `httpOnly` cookie (`arena_rt`, `SameSite=Lax`,
`Path=/v1/auth`, `Secure` outside development). Script cannot read it, but the
browser still sends it, so the client exchanges it for a fresh access token on
boot. The two properties hold together: an injected script can act only while
the page is open, rather than walking off with a 30-day credential.

`Path` scopes the cookie to the auth routes so it is not attached to every API
call. `SameSite=Lax` rather than `Strict` because `Strict` drops the cookie on a
cross-site navigation *into* the app — which breaks a link opened from a wallet's
in-app browser — while still refusing to send it on the cross-site subrequests
that CSRF actually needs.

The rotation and the cookie must move together. A refresh issues a new token and
invalidates the old one, so if the cookie kept the spent value the next reload
would present it, and the reuse check would read that as theft and revoke the
whole family — signing out a user who did nothing wrong. `/auth/refresh`
therefore re-sets the cookie on every rotation, and `/auth/logout` clears it with
the same `Path`, since a cookie is identified by name *and* path and clearing on
the wrong one leaves the original in place.

A body-carried token still works, and wins over the cookie when both are present:
non-browser clients hold their own token, and an explicit one must never be
silently overridden by a stale cookie.

Refresh tokens are stored hashed, so a database dump yields no usable
credentials. Plain SHA-256 rather than a password KDF is right here and would be
wrong for a password: the token is 256 bits of CSPRNG output, so there is no
dictionary to attack and bcrypt's slowness would buy nothing while costing a
hash on every refresh.

### Revocation

Two Redis reads on every authenticated request, answering different questions:

- **jti denylist** — "this specific token was logged out". TTL is the token's own
  remaining life, so entries evict exactly when they stop mattering. A denylist
  that grows forever is a slow leak that only bites in production.
- **Per-user session cut-off** — "every token this user holds is void". Required
  for a ban, because jti values are not stored and cannot be enumerated. Any
  token whose `iat` predates the cut-off is refused.

The comparison is strictly `<`: JWT `iat` has one-second resolution, so
rejecting on equality would log out the session the sign-in just created.

A ban calls `revokeAllSessions` **outside** the transaction that commits it. A
Redis failure must not roll back the ban — a banned player holding a live token
for a few more minutes is far better than a ban that silently did not happen.

## 4. Rate limiting

Keyed by **authenticated user where there is one, IP otherwise**. Both failure
modes of IP-only keying are real: thousands of players behind one carrier NAT
throttle each other into what looks like an outage, and an attacker with one
token and a pool of addresses gets a fresh budget per address.

The limiter runs before the auth hook, so the `sub` claim is read _unverified_
by `unverifiedSubject()`. Safe only because the value picks a bucket — forging
it moves the attacker to a different bucket, it does not raise the limit. The
function is named to make that obvious at the call site.

Redis-backed, not per-process: with N replicas a per-process counter hands an
attacker N times the intended budget.

Health and metrics are allow-listed. A rate-limited liveness probe restarts the
pod, turning a traffic spike into an outage.

Tighter per-route budgets where work is expensive or the endpoint is attractive:
`/auth/verify` 10/min, `adjust-balance` 10/min, `/matchmake` 30/min.

Plus per-wallet backoff on sign-in — ten consecutive failures locks a wallet out
for fifteen minutes. Not about the crypto, since signatures are not
brute-forceable, but about not burning nonce issuance and database lookups for a
wallet the attacker does not own.

## 5. DDoS protection

Honest framing: a volumetric flood is absorbed upstream by the CDN and load
balancer, because by the time packets reach Node the bandwidth is already paid
for. What this layer does is stop one client making the service expensive for
everyone — the attack that needs no botnet, and therefore the one that happens.

**HTTP** — `maxHeadersCount` 64, `headersTimeout` 10s (slowloris),
`requestTimeout`, `keepAliveTimeout` 30s, and `maxConnections` as a backstop so
a flood exhausts the listener rather than the heap. Rate limiting counts only
_completed_ requests, so none of these are covered by it.

**WebSocket** — `ConnectionGuard` throttles handshakes per address, in-process
and ahead of ticket verification. Rejecting costs a map lookup; verifying costs
an HMAC and a Redis round trip, and making us do that work is the point of the
flood. Not Redis-backed on purpose: a round trip to decide whether to accept a
connection is itself the work being weaponised. An attacker spread across N
nodes gets N times the budget — accepted, because the edge handles distributed
floods and this handles the single noisy client that gets past it.

The eviction sweep matters: without it, an attacker cycling source addresses
turns the limiter into the memory leak that takes the node down — the defence
becoming the vulnerability. Only fully-refilled buckets are evicted; evicting
one mid-throttle would hand back a free burst.

## 6. WebSocket authentication

Clients present a **matchmaker-issued ticket**, not a raw JWT. A JWT says who
you are and says nothing about which room you may enter.

```
POST /v1/matchmake -> { roomId, realtimeUrl, ticket, expiresAt }
socket.io connect with auth: { ticket }
```

HMAC-signed so the realtime node validates with no network call, **and**
registered in Redis so it is consumed exactly once — a signature alone would let
one ticket open unlimited sockets. Consumed with `GETDEL`, same reasoning as the
nonce. Thirty-second life: it is a hand-off, not a session.

Keyed by player id, so issuing a new ticket replaces the old and a player cannot
bank several to open concurrent sockets. A ticket naming a different `nodeId` is
refused rather than silently honoured.

Compact hand-rolled format rather than JWT: an internal credential with a
30-second life does not need algorithm negotiation, and JWT brings `alg: none`
and key-confusion surface that buys nothing here. Signature comparison is
constant-time, with a length check first because `timingSafeEqual` throws on
mismatched lengths.

Room membership is enforced by the ticket, not the client. A client cannot name
its own room, which removes the whole "join the room my friend is in and grief
them" class.

The matchmaker honours the gateway's revocation tombstones, so a banned player
cannot be placed into a room using a token minted seconds before the ban.

## 7. Input validation

Zod at every boundary, using the same schemas that generate the OpenAPI
document — so the spec cannot describe a contract the server does not enforce.

**Binary snapshots** carry a declared command count checked against actual
buffer length, so a lying header is rejected rather than read past.

**Socket events** were the gap. `chat` reached into `payload.body` directly, so a
null payload threw inside the handler; it is now parsed. Length is capped _at
the schema_ rather than sliced afterwards — a megabyte string truncated to 140
characters was still received, parsed and held in memory first.

`sanitiseChat` strips zero-width and bidirectional-override characters. They
render as nothing, pass every length check, and let a sender spoof another
player's name or reverse a line's visual order. **Order matters**: whitespace is
collapsed _before_ controls are stripped, because newlines live in the C0 range
and stripping first would silently join words across lines — changing what was
said rather than reformatting it. A test caught that.

## 8. Anti-cheat

The client is a renderer and a predictor. It is never an authority.

| Client claim      | Server response                                   |
| ----------------- | ------------------------------------------------- |
| `dt` (delta time) | Clamped to one tick; a forged value buys no speed |
| `angle`           | Clamped by the snake's turn rate per tick         |
| `seq`             | Must advance monotonically, bounded jump          |
| position          | Never accepted — the server owns all positions    |
| score             | Never accepted — derived server-side              |
| input rate        | Token bucket per socket                           |
| chat/ping/respawn | Token bucket per event, per socket                |

**Shape** checks live in `validators.ts`; **consequence** checks in
`movement.ts`, which compares travel distance against what the physics allows.

Compared in **ticks, not milliseconds**: the simulation is fixed-step, so tick
count is the exact number of movement steps that happened. Wall-clock would fold
in GC pauses and scheduler jitter and produce false positives on a loaded
server — precisely when a spurious cheat alarm is least welcome.

Distance is Euclidean, not per-axis. Checking axes independently would let a
diagonal cheat travel 41% further than allowed.

Chat, ping and respawn each cost real work and had no limiter. Chat is the worst
because it fans out to every socket in the room, so one sender multiplies into N
sends.

Signals accumulate into a suspicion score with per-signal weights — a malformed
angle has no innocent explanation, a rate-limited burst does — and the score
**decays**, so an honest player with one bad afternoon of packet loss is not
permanently marked. Crossing the threshold **shadowbans rather than kicks**: a
disconnected cheater learns which signal caught them and iterates against it.

## 9. RPC retry

Exponential backoff with centred jitter, clamped. Without jitter a fleet that
fails together retries together and reproduces the herd that caused the failure.
Program errors are **not** retried: they are deterministic, so a retry produces
the same rejection while consuming rate-limit budget.

Retry alone makes an outage worse, which is why there is a **circuit breaker**.
When an endpoint is down, every request spends four attempts and several seconds
of backoff before failing — so the struggling endpoint receives _more_ traffic
than when it was healthy, and every request handler stays open for the duration.
That is how a dependency's bad minute becomes our bad hour.

`closed -> open -> half-open`, with a **single probe**. Reopening the floodgates
after a cooldown sends the whole backlog at an endpoint that has had no time to
recover; the cycle repeats and reads as flapping, usually blamed on the
endpoint.

A success in the closed state does not clear failure history — the rolling
window does that. Clearing on success would let a service failing half its calls
stay closed forever.

## On-chain trust model

The Anchor program's scope is deliberately narrow: escrow and payout. Gameplay
is simulated off-chain because putting movement on-chain is neither fast enough
nor affordable.

That means the backend is trusted to report match results. The trust is bounded
by what the program enforces:

- Payouts must sum to pot minus fee — the backend cannot invent lamports.
- A match settles at most once — state flips to `Settled` before any transfer,
  so a re-entrant call cannot pay twice.
- Fee is capped at `MAX_FEE_BPS` (10%) — a compromised authority cannot set the
  rake to 100% and drain the pot.
- `cancel_match` is permissionless after the refund window — players can always
  recover funds without depending on the backend.

The settlement authority is a hot key held by the backend, and is rotatable via
`update_config` without a program upgrade.

Off-chain, settlement is idempotent on `matchId` (see the `Settlement` model's
`idempotencyKey`). A retry after a timeout must never pay out twice.

## Transport and headers

- Helmet on every service, plus HSTS and `Referrer-Policy: no-referrer` on the
  gateway. The API is JSON over HTTPS and is never framed, so both are free.
- CORS restricted to `CORS_ORIGINS`; no wildcard with credentials.
- `TRUST_PROXY` must be **false** unless actually behind a proxy — otherwise
  clients spoof `X-Forwarded-For` and bypass IP rate limits entirely. The same
  flag governs `clientAddress()` in the WebSocket connection guard.
- Security headers on the web app are set in `next.config.ts`.
- `/admin` is `noindex, nofollow`. Not a control — the gateway's role guard is —
  but there is no reason to advertise the operator console.

## Logging

`packages/logger` redacts tokens, signatures, keypairs and auth headers at the
Pino level rather than per call site. Wallet auth means signatures flow through
request bodies routinely, and one unredacted log line in an aggregator is a
durable leak.

## Known gaps

- **The sign-in lockout counter is per wallet, not per IP.** An attacker can lock
  out a wallet they do not own by failing verification ten times. The window is
  short, and the per-IP alternative is bypassed by rotating addresses, but this
  is a real griefing vector.
- **`revokeAllSessions` is best-effort.** If Redis is unreachable when a ban
  commits, the player keeps their access token until it expires naturally.
  Logged at error level.
- **`/internal/rooms` on the matchmaker is still a 501 stub**, so realtime nodes
  do not register individual rooms — `/matchmake` places on node capacity alone.
- **No CAPTCHA or proof-of-work on sign-in.** Nonce issuance is cheap but not
  free.
- **`MovementGuard` is written but not yet wired into the room tick.** The logic
  and its tests exist; nothing calls `observe()` yet.

## Reporting

TODO: add a disclosure policy with a contact address before any public
deployment.
