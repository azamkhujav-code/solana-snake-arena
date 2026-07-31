import { z } from 'zod';

/**
 * Browser configuration.
 *
 * Next.js replaces `process.env.NEXT_PUBLIC_X` at build time only for literal
 * property accesses, so each variable is named explicitly. Parsing here means a
 * missing variable fails the build rather than surfacing as `undefined` inside
 * a WebSocket URL at runtime.
 */
const clientEnvSchema = z.object({
  appName: z.string().min(1),
  appUrl: z.url(),
  gatewayUrl: z.url(),
  matchmakerUrl: z.url(),
  solanaCluster: z.enum(['devnet', 'testnet', 'mainnet-beta', 'localnet']),
  solanaRpcUrl: z.url(),
  arenaProgramId: z.string().min(32),
  enableDevtools: z.boolean(),
});

export type ClientEnv = z.infer<typeof clientEnvSchema>;

export const env: ClientEnv = clientEnvSchema.parse({
  appName: process.env.NEXT_PUBLIC_APP_NAME ?? 'Slither Arena',
  appUrl: process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000',
  gatewayUrl: process.env.NEXT_PUBLIC_GATEWAY_URL ?? 'http://localhost:4000',
  matchmakerUrl: process.env.NEXT_PUBLIC_MATCHMAKER_URL ?? 'http://localhost:4002',
  solanaCluster: process.env.NEXT_PUBLIC_SOLANA_CLUSTER ?? 'devnet',
  solanaRpcUrl: process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? 'https://api.devnet.solana.com',
  arenaProgramId:
    process.env.NEXT_PUBLIC_ARENA_PROGRAM_ID ?? 'Arena111111111111111111111111111111111111111',
  enableDevtools: process.env.NEXT_PUBLIC_ENABLE_DEVTOOLS === 'true',
});
