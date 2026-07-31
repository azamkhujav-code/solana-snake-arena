/**
 * Verifies that .env satisfies every service's schema before you start the
 * stack, so a typo surfaces here rather than as three services crash-looping.
 *
 *   pnpm env:check
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  gatewayEnvSchema,
  matchmakerEnvSchema,
  realtimeEnvSchema,
  workerEnvSchema,
  parseEnv,
  EnvValidationError,
} from '@arena/env/server';

function loadDotEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    console.error(`No .env found at ${path}. Copy .env.example first.`);
    process.exit(1);
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    out[key] = value.replace(/^["']|["']$/g, '');
  }
  return out;
}

const envPath = resolve(process.cwd(), '.env');
const fileEnv = loadDotEnv(envPath);

// Each service gets its own PORT in deployment; supply a default so the shared
// .env does not need three conflicting PORT entries.
const services = [
  { name: 'gateway', schema: gatewayEnvSchema, port: '4000' },
  { name: 'realtime', schema: realtimeEnvSchema, port: '4001' },
  { name: 'matchmaker', schema: matchmakerEnvSchema, port: '4002' },
  // No port: the worker consumes a queue rather than serving requests.
  { name: 'worker', schema: workerEnvSchema, port: undefined },
] as const;

let failed = false;

for (const service of services) {
  try {
    parseEnv(service.name, service.schema, { ...fileEnv, PORT: fileEnv.PORT ?? service.port });
    console.log(`  ok    ${service.name}`);
  } catch (error) {
    failed = true;
    if (error instanceof EnvValidationError) {
      console.error(`  FAIL  ${service.name}`);
      for (const issue of error.issues) console.error(`          ${issue}`);
    } else {
      console.error(`  FAIL  ${service.name}:`, error);
    }
  }
}

if (failed) {
  console.error('\nEnvironment validation failed. See .env.example for the expected shape.');
  process.exit(1);
}

console.log('\nAll service environments validate.');
