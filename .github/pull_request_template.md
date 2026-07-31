## What

<!-- One or two sentences. What changed and why. -->

## How

<!-- Notable implementation decisions, especially anything non-obvious. -->

## Scale impact

<!-- Required for changes to apps/realtime, apps/matchmaker or packages/protocol. -->

- [ ] No change to per-player bandwidth or per-tick CPU
- [ ] Changes bandwidth/CPU — measured impact:

## Checklist

- [ ] `pnpm lint && pnpm typecheck && pnpm test` passes locally
- [ ] Protocol changes bump `PROTOCOL_VERSION` in `packages/protocol/src/version.ts`
- [ ] Database changes ship a migration, and the migration is backwards-compatible
      with the currently deployed code (expand/contract, not rename-in-place)
- [ ] New environment variables are added to `.env.example` **and** the Zod schema
- [ ] On-chain changes have tests covering the adversarial cases
