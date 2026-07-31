import { z } from 'zod';

import { parseEnv } from './parse.js';
import { solanaClusterSchema } from './shared.js';

/**
 * Browser-visible configuration.
 *
 * Next.js inlines `process.env.NEXT_PUBLIC_*` at build time only when the full
 * property access is written literally, so the values are destructured
 * explicitly below rather than passing `process.env` wholesale.
 */
export const clientEnvSchema = z.object({
  NEXT_PUBLIC_APP_NAME: z.string().min(1).default('Slither Arena'),
  NEXT_PUBLIC_APP_URL: z.url().default('http://localhost:3000'),
  NEXT_PUBLIC_GATEWAY_URL: z.url().default('http://localhost:4000'),
  NEXT_PUBLIC_MATCHMAKER_URL: z.url().default('http://localhost:4002'),
  NEXT_PUBLIC_SOLANA_CLUSTER: solanaClusterSchema.default('devnet'),
  NEXT_PUBLIC_SOLANA_RPC_URL: z.url().default('https://api.devnet.solana.com'),
  NEXT_PUBLIC_ARENA_PROGRAM_ID: z.string().min(32),
  NEXT_PUBLIC_SENTRY_DSN: z.string().optional(),
  NEXT_PUBLIC_ENABLE_DEVTOOLS: z.enum(['true', 'false']).default('false'),
});

export type ClientEnv = z.infer<typeof clientEnvSchema>;

export function readClientEnv(): ClientEnv {
  return parseEnv('web:client', clientEnvSchema, {
    NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_GATEWAY_URL: process.env.NEXT_PUBLIC_GATEWAY_URL,
    NEXT_PUBLIC_MATCHMAKER_URL: process.env.NEXT_PUBLIC_MATCHMAKER_URL,
    NEXT_PUBLIC_SOLANA_CLUSTER: process.env.NEXT_PUBLIC_SOLANA_CLUSTER,
    NEXT_PUBLIC_SOLANA_RPC_URL: process.env.NEXT_PUBLIC_SOLANA_RPC_URL,
    NEXT_PUBLIC_ARENA_PROGRAM_ID: process.env.NEXT_PUBLIC_ARENA_PROGRAM_ID,
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
    NEXT_PUBLIC_ENABLE_DEVTOOLS: process.env.NEXT_PUBLIC_ENABLE_DEVTOOLS,
  });
}
