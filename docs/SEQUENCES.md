# Sequence diagrams

Seven flows. Each is annotated with the failure it is shaped to survive, because
that is usually why a step exists where a simpler design would have fewer.

## 1. Wallet sign-in

```mermaid
sequenceDiagram
    autonumber
    participant C as Browser
    participant P as Phantom
    participant G as gateway
    participant R as Redis
    participant DB as Postgres

    C->>G: POST /v1/auth/nonce { wallet }
    G->>R: SET auth:nonce:{wallet} EX 300
    G-->>C: { nonce, message, expiresAt }

    Note over C,P: The client signs the message verbatim.<br/>It never composes one itself.
    C->>P: signMessage(message)
    P-->>C: ed25519 signature

    C->>G: POST /v1/auth/verify { wallet, signature, nonce }
    G->>R: GETDEL auth:nonce:{wallet}
    Note right of R: Atomic. GET-then-DEL lets two<br/>concurrent requests both see it unused.
    R-->>G: nonce record (or null)

    alt nonce absent or mismatched
        G-->>C: 401 — unknown, expired or already used
    else signature invalid
        Note over G: The nonce is already consumed,<br/>so a failed attempt cannot be retried.
        G->>R: INCR auth:fail:{wallet}
        G-->>C: 401
    else valid
        G->>DB: upsert user + wallet, stamp verifiedAt
        G->>DB: INSERT refresh_tokens (SHA-256 of token)
        G->>R: DEL auth:fail:{wallet}
        G-->>C: { player, accessToken, refreshToken }
    end
```

**Shaped by:** replay. The nonce is consumed _before_ the signature is checked,
so a captured message cannot be brute-forced against a challenge that would
otherwise stay alive for five minutes. The server rebuilds the signed message
from its own stored nonce — verifying a client-supplied string would let a caller
sign `"hello"` and present it as proof of anything.

## 2. Refresh rotation and theft detection

```mermaid
sequenceDiagram
    autonumber
    participant C as Browser
    participant G as gateway
    participant DB as Postgres

    C->>G: POST /v1/auth/refresh { refreshToken }
    G->>DB: SELECT by SHA-256(token)

    alt token unknown
        G-->>C: 401
    else revokedAt IS NOT NULL
        Note over G,DB: Two parties hold this token and there is<br/>no way to tell which is the owner.
        G->>DB: revoke the entire family
        G-->>C: 401 TOKEN_REUSE_DETECTED
    else valid
        G->>DB: revoke this token
        Note right of DB: Revoke first, issue second.<br/>A crash between them fails closed.
        G->>DB: INSERT successor in the same family
        G-->>C: new access + refresh pair
    end
```

**Shaped by:** token theft. Logging a legitimate user out is a far cheaper
mistake than leaving a thief with a live session, so ambiguity resolves toward
revocation.

## 3. Deposit

```mermaid
sequenceDiagram
    autonumber
    participant C as Browser
    participant P as Phantom
    participant G as gateway
    participant DB as Postgres
    participant S as Solana
    participant RC as reconciler

    C->>G: POST /v1/wallet/deposits { amount }
    G->>DB: INSERT deposits (PENDING, expires in N min)
    G-->>C: { depositId, poolAddress, programId }

    Note over C,S: No funds move server-side.<br/>The client builds and signs the transfer.
    C->>P: sign transfer → pool vault
    P->>S: submit
    S-->>C: signature

    C->>G: POST /v1/wallet/deposits/confirm { depositId, signature }
    G->>S: getParsedTransaction(signature)

    alt not yet indexed
        G-->>C: { status: "pending" }
        Note over RC: The client may now vanish.<br/>Recovery does not depend on it.
        RC->>S: retry lookup
        RC->>DB: post ledger legs, mark CONFIRMED
    else confirmed
        G->>DB: BEGIN
        G->>DB: INSERT 2 legs (EXTERNAL → custody), unique on signature
        G->>DB: UPDATE pool_accounts (optimistic version)
        G->>DB: COMMIT
        G-->>C: { status: "confirmed", creditedLamports }
    end
```

**Shaped by:** the client disappearing between signing and confirming. The money
has moved on chain but the database does not know it. `pending` is a real
outcome rather than a blocking wait, and the reconciler closes the gap. Crediting
is keyed on the signature by a unique constraint, so the client and the
reconciler racing is safe — whichever arrives first posts, the other collides.

## 4. Join a match

```mermaid
sequenceDiagram
    autonumber
    participant C as Browser
    participant M as matchmaker
    participant R as Redis
    participant RT as realtime

    C->>M: POST /v1/matchmake { mode, region }
    M->>R: SMEMBERS cluster:nodes + MGET heartbeats
    Note right of R: One MGET, not a read per node —<br/>otherwise cluster size enters join latency.

    alt no healthy node
        M-->>C: 503 — retry, nothing is broken
    else placed
        M->>M: filterHealthy → selectPlacement
        M->>R: SET ticket:{playerId} PX 30000
        M-->>C: { roomId, realtimeUrl, ticket }
    end

    C->>RT: WS connect, auth: { ticket }
    RT->>RT: connection-rate guard (in process)
    RT->>RT: verify HMAC, expiry, nodeId
    RT->>R: GETDEL ticket:{playerId}

    alt already consumed
        RT-->>C: connect_error INVALID_TICKET
    else fresh
        RT->>RT: ensureRoom → addPlayer → join(roomId)
        RT-->>C: Joined { tickRate, snapshotRate, worldRadius }
        loop every 1/15s
            RT-->>C: binary snapshot (area-of-interest filtered)
        end
    end
```

**Shaped by:** a client choosing its own room. The ticket is a signed capability
naming one room on one node, so a modified client cannot join a friend's match to
grief them. It is HMAC-signed so the node validates with no network call, _and_
registered in Redis so it is consumed exactly once — a signature alone would let
one ticket open unlimited sockets.

## 5. Playing a tick

```mermaid
sequenceDiagram
    autonumber
    participant C as Browser
    participant RT as realtime
    participant SIM as game-core

    loop client frame
        C->>C: predict locally with the same module
        C->>RT: input batch { seq, angle, boost, dt }
    end

    loop server tick, 30Hz
        RT->>RT: validateInputBatch — seq, rate, angle, dt
        Note right of RT: A forged dt is the simplest speed hack.<br/>Clamping to one tick makes it worthless.
        RT->>SIM: enqueueInput + step(world)
        SIM-->>RT: TickResult { deaths, eats }

        alt a player died
            RT->>RT: capture finalScore before despawn
            RT-->>C: Died broadcast to the whole room
            Note right of RT: The killer must hear it too, or no<br/>client can maintain a kill counter.
        end
    end

    loop snapshot tick, 15Hz
        RT->>RT: area-of-interest filter per viewer
        RT-->>C: binary snapshot
        C->>C: reconcile prediction against authority
    end
```

**Shaped by:** bandwidth and cheating. Without per-viewer AOI filtering the
per-room cost is O(players²). Scores and positions are never accepted from a
client — only intent travels upward.

## 6. Settlement

```mermaid
sequenceDiagram
    autonumber
    participant RT as realtime
    participant G as gateway
    participant Q as BullMQ
    participant W as worker
    participant DB as Postgres
    participant S as Solana

    RT->>G: POST /v1/internal/matches/{id}/settle
    G->>Q: enqueue, job id = matchId
    Note right of Q: Deterministic job id — a retried report<br/>collapses onto the same job.

    W->>DB: load game + participants
    W->>W: verifyResult — entrants known, scores sane
    alt verification fails
        W->>DB: settlementStatus = FAILED
        Note over W,DB: Surfaces on the admin dashboard.<br/>No payout is attempted.
    else verified
        W->>W: computePayouts — sums to pot minus rake
        W->>S: distribute_winnings(payouts)
        Note right of S: The program re-checks the sum.<br/>A compromised backend can misallocate,<br/>but cannot mint or skim.

        alt chain rejects or times out
            W->>DB: settlementStatus = FAILED, record error
        else confirmed
            W->>DB: BEGIN
            W->>DB: ledger legs — escrow → custody, escrow → rake
            W->>DB: game.settlementSignature (unique)
            W->>DB: upsert leaderboard windows
            W->>DB: COMMIT
        end
    end
```

**Shaped by:** paying twice. Idempotency is layered — a deterministic queue job
id, a unique `settlementSignature`, unique ledger idempotency keys, and the
program's own once-only state transition. Any single layer failing still leaves
the pot payable exactly once.

## 7. Admin balance adjustment

```mermaid
sequenceDiagram
    autonumber
    participant A as Operator
    participant G as gateway
    participant DB as Postgres

    A->>G: POST /v1/admin/players/{id}/adjust-balance
    Note over A,G: Requires a signed amount, a reason of<br/>at least 8 chars, and an idempotency key.

    G->>G: authenticate → requireRole(ADMIN)
    G->>DB: SELECT by idempotency key

    alt key already used
        G-->>A: { alreadyApplied: true } — nothing moved
    else new
        G->>DB: BEGIN
        G->>DB: UPDATE custody (optimistic version)
        G->>DB: UPDATE treasury (optimistic version)
        G->>DB: INSERT 2 ADJUSTMENT legs summing to zero
        G->>DB: INSERT audit_logs (CRITICAL, actor, reason, before/after)
        Note right of DB: Same transaction. If the audit write fails,<br/>the money movement rolls back with it.
        G->>DB: COMMIT
        G-->>A: { entryGroupId, balanceLamports }
    end
```

**Shaped by:** an operator moving money with no trace. The audit row is written
_inside_ the same transaction as the change, so there is no path that produces a
balance change nobody can account for. Logging afterwards would leave a window,
and that window is exactly where a hostile or careless operator hides.

## Cross-cutting: what happens when the chain is unreachable

```mermaid
sequenceDiagram
    autonumber
    participant Svc as Any service
    participant CB as CircuitBreaker
    participant RPC as Solana RPC

    Svc->>CB: execute(call)

    alt circuit closed
        CB->>RPC: call, with retry + jittered backoff
        alt fails repeatedly
            CB->>CB: failure count crosses threshold → open
        end
    else circuit open
        CB-->>Svc: CircuitOpenError immediately
        Note right of CB: Failing in 1ms beats failing in 8s.<br/>Retry alone sends MORE traffic to a<br/>struggling endpoint than when healthy.
    else cooldown elapsed
        CB->>RPC: exactly one probe
        alt probe succeeds
            CB->>CB: half-open → closed after N successes
        else probe fails
            CB->>CB: back to open, cooldown restarts
        end
    end
```

**Shaped by:** amplifying an upstream outage. A single probe rather than
reopening the floodgates, because the whole backlog arriving at an endpoint that
has had no time to recover reads as flapping and gets blamed on the endpoint.
