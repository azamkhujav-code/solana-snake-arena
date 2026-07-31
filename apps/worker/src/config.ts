import { getWorkerEnv, type WorkerEnv } from '@arena/env/server';

/**
 * Worker environment.
 *
 * The schema itself lives in `@arena/env` alongside every other service's, so
 * `pnpm env:check` validates all four in one pass. A schema defined locally is
 * a schema the pre-deploy check silently skips — and this is the process that
 * signs settlement transactions.
 */
export type Config = WorkerEnv;

export const config: Config = getWorkerEnv();
