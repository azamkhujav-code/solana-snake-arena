# Contributing

## Setup

```bash
pnpm install
cp .env.example .env
pnpm env:check
pnpm docker:up
pnpm db:migrate
pnpm dev
```

## Workflow

Branch from `main`, open a PR, and let CI run. Husky enforces the fast checks
locally:

| Hook         | Runs                          |
| ------------ | ----------------------------- |
| `pre-commit` | `lint-staged` on staged files |
| `commit-msg` | `commitlint`                  |
| `pre-push`   | `turbo run typecheck`         |

`pre-push` is typecheck only on purpose. Blocking every push on the full suite
trains people to reach for `--no-verify`, which defeats the hook entirely.

## Commit format

Conventional Commits, with the scope drawn from the enum in
`commitlint.config.mjs`:

```
feat(realtime): add spatial-hash broad phase
fix(protocol): correct angle quantisation rounding
chore(deps): bump fastify to 5.11
```

## Adding a package

1. `packages/<name>/package.json` — name it `@arena/<name>`, `"private": true`,
   `"type": "module"`.
2. `tsconfig.json` extending the right preset from `@arena/typescript-config`.
3. `eslint.config.mjs` re-exporting the right config from `@arena/eslint-config`.
4. Standard scripts: `build`, `dev`, `typecheck`, `lint`, `test`, `clean`.
5. Add it to consumers with `"@arena/<name>": "workspace:*"`.

Packages compile to `dist/` and are consumed as built output, so relative imports
in source must carry the `.js` extension — that is what NodeNext ESM resolution
requires.

## Conventions

**Contracts live in `@arena/protocol`.** Zod schemas are the single source of
truth: Fastify validates with them, TanStack Query infers response types from
them. A contract change should break compilation on both sides, which is the
point.

**The simulation must stay deterministic.** No `Date.now()`, no `Math.random()`
— use `createRng(seed)`. Client and server run the same code, and a divergent RNG
stream is indistinguishable from a desync bug while being much harder to
reproduce.

**Nothing blocking in the tick loop.** No `await`, no IO, no unbounded
allocation. The budget is 33 ms for every room on the node.

**Never trust the client.** Positions, scores and timings are derived
server-side. See [docs/SECURITY.md](docs/SECURITY.md).

## Changing the protocol

1. Update the schema or binary layout in `packages/protocol`.
2. Bump `PROTOCOL_VERSION` — major for anything that changes existing field
   order or semantics, minor for additive changes.
3. Update both the encoder and the decoder. They are separate functions and
   nothing type-checks them against each other; a round-trip test is the only
   thing that catches a mismatch.
4. Note the bandwidth impact in the PR.

## Database changes

Migrations must be backwards-compatible with the currently deployed code.
Realtime nodes drain over minutes, so both versions run concurrently during a
rollout. Expand now, contract in a later release. See
[docs/OPERATIONS.md](docs/OPERATIONS.md).

## Testing

```bash
pnpm test              # everything
pnpm test:watch        # watch mode
pnpm --filter @arena/protocol test
```

Priorities, in order: binary codec round-trips, simulation determinism (same
seed and inputs produce identical state), placement strategy edge cases, and the
adversarial on-chain paths — double settlement, mismatched payouts, unauthorised
settler.
