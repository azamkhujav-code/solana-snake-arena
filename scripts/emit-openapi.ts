/**
 * Writes each service's OpenAPI document to `docs/api/`.
 *
 *   pnpm openapi
 *
 * Committing the generated spec makes contract changes visible in review — a
 * removed field or a changed status code shows up as a diff rather than being
 * discovered by a client at runtime. CI regenerates and fails if the checked-in
 * copy is stale.
 *
 * Booting the real app is what makes this trustworthy: the document comes from
 * the same route registrations the server actually serves, so it cannot
 * describe an endpoint that does not exist. The cost of that is real
 * dependencies — Postgres and Redis must be up.
 *
 * CI does not run this. What can actually break — a Zod schema the JSON Schema
 * converter rejects, an untagged operation — is covered by the swagger tests in
 * each service, which build the document with stubbed decorators and need no
 * infrastructure at all.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const OUT_DIR = resolve(process.cwd(), 'docs/api');

interface ServiceSpec {
  name: string;
  /** Module exporting `buildApp()`. */
  entry: string;
}

// Source, not dist: tsx compiles on the fly, so the spec can be regenerated
// without a build step standing between an edit and the document.
const SERVICES: ServiceSpec[] = [
  { name: 'gateway', entry: '../apps/gateway/src/app.js' },
  { name: 'matchmaker', entry: '../apps/matchmaker/src/app.js' },
];

async function emit(service: ServiceSpec): Promise<void> {
  const module = (await import(service.entry)) as {
    buildApp: () => Promise<{
      ready: () => Promise<unknown>;
      swagger: () => unknown;
      close: () => Promise<void>;
    }>;
  };

  const app = await module.buildApp();
  await app.ready();

  const document = app.swagger();
  const target = resolve(OUT_DIR, `${service.name}.openapi.json`);

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);

  await app.close();
  console.log(`  wrote ${target}`);
}

async function main(): Promise<void> {
  for (const service of SERVICES) {
    try {
      await emit(service);
    } catch (error) {
      // Booting requires a database and Redis. Say so plainly rather than
      // dumping a connection stack trace that looks like a code bug.
      console.error(`  FAILED ${service.name}:`, error instanceof Error ? error.message : error);
      console.error('  (this script boots the real app; Postgres and Redis must be running)');
      process.exitCode = 1;
    }
  }
}

await main();
