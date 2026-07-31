# Admin dashboard

Operator console at `/admin` in the web app, backed by `/v1/admin/*` on the
gateway. Eight pages: Statistics, Treasury, Pool Accounts, Transactions,
Players, Games, Rooms, Logs.

## Authorisation

Two scopes, registered in [`routes/admin/index.ts`](../apps/gateway/src/routes/admin/index.ts):

| Scope        | Role                 | Pages                                                   |
| ------------ | -------------------- | ------------------------------------------------------- |
| Read-only    | `MODERATOR`, `ADMIN` | Statistics, Treasury, Pool Accounts, Transactions, Logs |
| Read + write | `ADMIN`              | Players, Games, Rooms                                   |

The guard is a **hook on the encapsulated scope**, not a per-route option.
Nineteen routes each remembering `requireRole('ADMIN')` is nineteen chances to
forget, and the one that forgets is a public endpoint serving every player's
balance. A route added to the scope later inherits the guard whether or not its
author thought about it. [`guard.test.ts`](../apps/gateway/src/routes/admin/guard.test.ts)
verifies that claim rather than trusting it: Prisma is a throwing stub, so a
request that reaches a handler fails the test loudly.

The read/write split exists because a support agent needs to look things up all
day, and giving them balance-mutation rights so they can do so is how an
internal fraud story starts.

Insufficient role returns **403, not 401**. A 401 tells the client its token is
bad, so it discards a valid session and sends the user to sign in again — which
fails identically, because signing in was never the problem.

The client-side check in `AdminShell` hides navigation only. The browser is the
attacker's computer; the gateway hook is the control.

## Audit trail

Every mutating action writes an `audit_logs` row **inside the same database
transaction as the change it describes**. If the audit write fails, the mutation
rolls back. There is no path that produces a balance change nobody can account
for — logging after the fact would leave a window where the two disagree, and
that window is exactly where a hostile or careless operator hides.

Actions are a closed set (`AUDIT_ACTIONS` in
[`lib/audit.ts`](../apps/gateway/src/lib/audit.ts)) so the log can be filtered
and alerted on. A free-form string drifts into `player_ban`, `ban-player` and
`banPlayer`, at which point no query finds all the bans.

Severity is assigned by consequence, not by endpoint: granting `ADMIN` and
adjusting a balance are `CRITICAL`; a ban is `WARN`; a reinstatement is `INFO`.

Client IPs are stored salted-SHA256, never raw. The only question they need to
answer is whether two actions came from the same place, and a hash answers that
without making the table a GDPR liability. The salt matters — the IPv4 space is
small enough to enumerate, so an unsalted hash is an encoding, not a protection.

### Logs ≠ application logs

The Logs page shows the **audit trail**. Request and error logs go from Pino to
stdout and from there to the log shipper; they answer "what did the process do?"
and live under a retention policy. The audit table answers "who touched this
player's money?" and has to outlive them. The page says so, because "Logs"
invites the other expectation.

## Treasury reconciliation

The page an operator should open first. Three independent numbers must agree:

1. What the chain holds in the vault PDAs.
2. What the pool-account balances say.
3. What the sum of posted ledger entries says.

**(2) vs (3) — `ledgerDriftLamports`.** Non-zero means a balance moved without a
matching entry, or the reverse. It is a software bug and no amount of retrying
fixes it.

**(1) vs what players are owed — `custodyCoverageLamports`.** Negative is
insolvency: the vault holds less than custody + escrow. Escrow counts as owed —
lamports locked in a live game are still a player's, merely committed. Counting
only custody would make the platform look solvent during a match and insolvent
the moment it ended, which inverts when the alarm should fire.

It is **null, not zero, when the RPC is unreachable**. An outage is not evidence
of a shortfall, and rendering it as one pages someone at 3am for a network blip.

**`imbalancedEntryGroups`** catches what neither total-vs-total check can: two
broken transfers whose errors cancel out platform-wide. Scanned over 24h only —
a group broken six months ago is a job for the offline audit, not a page that
auto-refreshes.

The arithmetic lives in [`admin-treasury.ts`](../apps/gateway/src/services/admin-treasury.ts)
as pure functions, tested independently, because it is the part that can be
wrong in a way that looks right.

## Alerts

`deriveAlerts` emits only genuine problems. A dashboard that always shows a
warning trains its operators to ignore warnings, and then the real one scrolls
past. Criticals sort ahead of warnings, and insolvency ahead of everything —
it is the only condition whose correct response is to stop taking deposits.

| Code                     | Severity | Meaning                           |
| ------------------------ | -------- | --------------------------------- |
| `CUSTODY_INSOLVENT`      | critical | Vault below what players are owed |
| `LEDGER_DRIFT`           | critical | Pool balances ≠ posted ledger     |
| `ENTRY_GROUP_IMBALANCED` | critical | Transfer legs do not sum to zero  |
| `SETTLEMENT_FAILED`      | warn     | Winners not paid; retryable       |
| `WITHDRAWAL_STUCK`       | warn     | Held for manual review            |

## What the dashboard deliberately cannot do

- **Edit or delete a ledger entry.** The ledger is append-only; a mistake is
  corrected by posting a compensating entry. An edit button would quietly undo
  the guarantee that makes the history worth trusting.
- **Edit a finished game.** It is a financial record. Same reasoning.
- **Change a room's entry fee or rake.** Repricing a room players are queued in
  changes the deal they agreed to. Close it and open a new one, which leaves the
  old terms visible in history. The fields render as read-only with the reason
  attached rather than being omitted — an operator looking for them needs to
  learn they are absent on purpose, not conclude the page is broken.
- **Change your own role.** Self-demotion locks the last admin out; self-promotion
  is the move an attacker with a moderator token makes.
- **Ban an admin.** Demote first. Otherwise a support escalation turns into two
  admins banning each other.

## Balance adjustment

`POST /v1/admin/players/:id/adjust-balance` posts a two-leg `ADJUSTMENT` entry
between the player's custody account and the treasury. It is a real ledger
movement, not a balance edit — the books stay balanced and the correction is as
auditable as any other transfer.

Deliberately awkward to call: a signed amount, a mandatory reason of at least
eight characters, and a caller-supplied idempotency key. Adjusting a player's
money by hand should feel like filing paperwork, because that is what it is.

Idempotent on `adjust:{userId}:{key}`, so a retry after a dropped response
returns the existing entry rather than paying twice. The UI derives the key from
the amount and reason, so a double-click is the same request while a genuinely
different correction is a different one.

Refuses to drive a balance negative: nothing downstream can represent a player
who owes the platform.

## Cancelling an abandoned match

`POST /v1/admin/games/:id/cancel` marks a game `CANCELLED` and posts two-leg
`REFUND` entries returning each entry fee from the game's escrow to the custody
account it came from.

It exists because `close-lobby` is the point of no return. Once
`consumeReservations` has moved the stakes into escrow, every later stage can
still fail — the node never reports, verification rejects the result, a stage
burns its retry budget — and before this endpoint the pot simply stayed there.
The cycle now cancels itself in those cases; this is the manual path for a game
it could not reach, and the one an operator uses after a complaint.

The games list surfaces the candidates: the **Unaccounted** column is the
escrow's current balance, so any finished game showing a non-zero figure has a
pot that went neither to a winner nor back to the players. `unaccountedOnly`
filters to exactly those.

Refund amounts come from the ledger — the posted `ENTRY_FEE` credits against
that escrow — not from `game_players.entry_paid_lamports`. Participant rows are
written later in the cycle than the stakes are consumed, so a match that died in
between has a funded escrow and no participant rows at all, which is precisely
the case this endpoint is for.

Idempotent per player on `refund:{gameId}:{userId}`. A second click reports the
game as already cancelled and moves nothing.

It refuses in two situations, both of which mean the request is a
misdiagnosis rather than a retry:

- **The game already settled.** Its pot went to a winner; refunding it as well
  would pay the same lamports out twice.
- **The escrow holds less than is owed.** Something took money out without
  recording it. Covering the difference would invent lamports, so the endpoint
  reports the shortfall instead and the account needs reconciling first.

## Amounts in the UI

Every figure goes through [`lib/lamports.ts`](../apps/web/src/lib/lamports.ts),
which does bigint arithmetic. `Number(lamports) / 1e9` is wrong above ~9M SOL,
where the count exceeds `Number.MAX_SAFE_INTEGER` and the division silently
rounds. On a page showing a balance and a drift figure side by side, a rounding
error of a few lamports is indistinguishable from the bug the page exists to
detect.

Displays truncate rather than round — an operator comparing against the chain
should never see a number larger than what is actually there. The exact lamport
count is in the `title` attribute of every amount: the rounded display is for
scanning, the exact figure is for the incident report.

## Performance notes

Poll intervals are 30–60s, not 5s. An operator dashboard left open on a wall
display is a client that never goes away, and every endpoint here runs aggregate
queries — treasury also makes a chain call. Polling hard would be a
self-inflicted load test against the database serving real money.

Every statistics query is bounded by an indexed time column. `unaccountedOnly`
on the games list filters in memory on the joined escrow balance; it is paired
with `status = COMPLETED` and over-fetches with a hard cap so it cannot become
an unbounded scan.
