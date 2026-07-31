# Networking

## Rates

| Channel         | Rate   | Direction | Encoding |
| --------------- | ------ | --------- | -------- |
| Simulation tick | 30 Hz  | server    | —        |
| Snapshot        | 15 Hz  | S → C     | binary   |
| Input batch     | 20 Hz  | C → S     | binary   |
| Leaderboard     | 1 Hz   | S → C     | JSON     |
| Heartbeat       | 0.2 Hz | both      | JSON     |

Snapshot rate is deliberately half the tick rate. Interpolation covers the gap
invisibly, and it halves the largest bandwidth line item.

## Snapshot pipeline

```
simulate tick
      │
      ▼
for each viewer:
  spatial hash query (AOI)
      │
      ▼
  diff vs previous visible set  →  entered / stayed / exited
      │
      ▼
  encode binary delta (positions relative to viewer, quantised i16)
      │
      ▼
  emit to socket
```

Per-viewer work is proportional to _visible_ entities, not room population. That
is the whole reason a 120-player room is affordable.

## Binary layout

Defined in `packages/protocol/src/binary.ts`. Header is 20 bytes:

```
u8   messageType
u8   flags          bit 0 = full snapshot, bit 1 = compressed
u16  snakeCount
u16  foodCount
u32  tick
u32  serverTime     ms since room start — not epoch, so it fits in u32
u32  ackSeq
```

Positions are quantised relative to the viewer at `POSITION_SCALE = 4`, giving
0.25-unit precision — far below what is visible at render scale, and half the
bytes of a float32. Angles pack into `u16` across a full turn.

`serverTime` is milliseconds since the room started rather than a Unix epoch
timestamp specifically so it fits in 32 bits; an epoch value in milliseconds
does not.

## Client-side prediction

```
input sampled ──► apply locally (predicted) ──► render immediately
      │
      └──► buffered with seq ──► sent to server
                                       │
                                       ▼
                              server applies, echoes ackSeq
                                       │
      ┌────────────────────────────────┘
      ▼
snapshot arrives:
  drop buffered inputs ≤ ackSeq
  snap local state to authoritative
  replay remaining buffered inputs
```

The replay **must** use the same `Simulation` from `@arena/game-core` that the
server runs. A separate client-side movement implementation will drift, and the
symptom — the player's own snake jittering while every other snake looks smooth
— is confusing enough that it is worth stating explicitly.

## Interpolation

Remote entities render at `serverTime - INTERPOLATION_DELAY_MS` (100 ms). The
renderer finds the two snapshots bracketing that timestamp and lerps between
them.

This trades a fixed 100 ms of visual latency for smoothness that survives jitter
and a dropped packet. A lower delay looks more responsive until the first packet
is late, at which point remote snakes stutter. 100 ms comfortably covers one
missed snapshot at 15 Hz (66 ms).

When the buffer runs dry, extrapolate briefly, then freeze. Extrapolating
indefinitely produces snakes that confidently walk through walls.

## Clock synchronisation

RTT is sampled repeatedly, outliers discarded, and a running median kept. A
wrong clock offset does not look like a clock bug — it looks like permanent
stutter, because the renderer is sampling the interpolation buffer at the wrong
point.

## Rate limiting

Per-socket input limiting is enforced **in process** with a token bucket on
`socket.data.inputBudget`. A Redis round-trip per input packet at 20 Hz × 100k
players would be 2M ops/sec. Redis is only involved when a socket is actually
punished, which is rare.

Over-budget packets are dropped silently. Repeat offenders are disconnected and
recorded in `audit_logs`.

## Reconnection

`connectionStateRecovery` is enabled with a window equal to
`RECONNECT_GRACE_SECONDS`. A player's snake stays alive during that window, so a
brief network blip does not cost them their run. Past the window the snake dies
and scatters mass as food, exactly as any other death.

On drain, the server sends `Migrate` rather than simply closing. The client then
re-matchmakes to a new node instead of retrying a connection to a node that is
going away.
