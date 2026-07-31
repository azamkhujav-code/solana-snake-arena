/**
 * Copies the Anchor build artifacts into this package so TypeScript consumers
 * get a typed program client without reaching into programs/target.
 *
 * Run after `anchor build`:
 *   pnpm --filter @arena/solana sync:idl
 *
 * TODO: implement — copy programs/target/idl/arena.json to src/idl/arena.json
 * and programs/target/types/arena.ts to src/idl/arena.ts, then rewrite
 * src/idl/index.ts to re-export them.
 */
console.error('sync:idl is not implemented yet. Run `anchor build` first.');
process.exitCode = 1;
