import { spawnSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Documentation accuracy tests.
 *
 * Documentation rots silently. A renamed env var, a moved file, a deleted
 * endpoint — none of these break a build, and the doc that describes them stays
 * confidently wrong until someone follows it and loses an afternoon. A wrong
 * doc is worse than a missing one, because a missing one sends you to the code.
 *
 * These pin the claims that are mechanically checkable. They deliberately do
 * *not* try to check prose: a test asserting that a paragraph is accurate is a
 * test asserting that a string has not changed, which fails on every edit and
 * gets deleted within a month.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function readText(path: string): Promise<string> {
  return readFile(join(ROOT, path), 'utf8');
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(join(ROOT, path));
    return true;
  } catch {
    return false;
  }
}

/** Every markdown file that is documentation rather than a dependency's. */
async function docFiles(): Promise<string[]> {
  const files = ['README.md', 'CONTRIBUTING.md'];

  for (const entry of await readdir(join(ROOT, 'docs'))) {
    if (entry.endsWith('.md')) files.push(join('docs', entry));
  }

  return files;
}

describe('documentation links', () => {
  it('resolves every relative link to a file that exists', async () => {
    // The failure this catches: a doc renamed or moved, leaving links that 404
    // in the GitHub UI and give no hint where the content went.
    const broken: string[] = [];

    for (const file of await docFiles()) {
      const content = await readText(file);
      const base = dirname(join(ROOT, file));

      for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = match[1];
        if (!target || /^(https?:|mailto:|#)/.test(target)) continue;

        // Strip anchors and line suffixes: `foo.ts#L10`, `foo.md#heading`.
        const path = target.split('#')[0];
        if (!path) continue;

        const resolved = relative(ROOT, resolve(base, path));
        if (!(await exists(resolved))) broken.push(`${file} -> ${target}`);
      }
    }

    expect(broken).toEqual([]);
  });

  it('parses every mermaid diagram with the real mermaid parser', async () => {
    // Delegated to a plain Node script. Mermaid sanitises HTML in node labels
    // through DOMPurify, which needs a real `window` installed *before* the
    // module is evaluated — Vitest's own environment setup happens too late,
    // and diagrams without a `<br/>` pass regardless, so the gap is easy to
    // miss until exactly the diagrams worth having are the ones that break.
    const result = spawnSync(process.execPath, [join(ROOT, 'scripts/check-mermaid.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
    });

    // The script's own output names the file and line of any failure.
    expect(`${result.stdout}${result.stderr}`.trim()).toMatch(/\d+ Mermaid diagrams parsed/);
    expect(result.status).toBe(0);
  }, 60_000);

  it('balances every code fence', async () => {
    // An unclosed fence swallows the rest of the document into a code block,
    // which is invisible in a diff and obvious only in the rendered page.
    const unbalanced: string[] = [];

    for (const file of await docFiles()) {
      const fences = ((await readText(file)).match(/^```/gm) ?? []).length;
      if (fences % 2 !== 0) unbalanced.push(`${file} (${fences} fences)`);
    }

    expect(unbalanced).toEqual([]);
  });
});

describe('environment documentation', () => {
  /** Variable names declared across the Zod env schemas. */
  async function schemaVars(): Promise<Set<string>> {
    const sources = await Promise.all([
      readText('packages/env/src/shared.ts'),
      readText('packages/env/src/server.ts'),
      readText('packages/env/src/client.ts'),
    ]);

    const names = new Set<string>();
    for (const source of sources) {
      for (const match of source.matchAll(/^\s{2,}([A-Z][A-Z0-9_]{2,}):/gm)) {
        if (match[1]) names.add(match[1]);
      }
    }
    return names;
  }

  async function exampleVars(): Promise<Set<string>> {
    const content = await readText('.env.example');
    const names = new Set<string>();

    for (const match of content.matchAll(/^([A-Z][A-Z0-9_]{2,})=/gm)) {
      if (match[1]) names.add(match[1]);
    }
    return names;
  }

  it('documents every variable the schemas require', async () => {
    // A required variable absent from `.env.example` means a new developer's
    // first `pnpm dev` fails on a value they were never told about.
    const [schema, example] = await Promise.all([schemaVars(), exampleVars()]);

    const optional = new Set([
      // Genuinely optional and environment-specific: absent locally by design.
      'SENTRY_DSN',
      'NEXT_PUBLIC_SENTRY_DSN',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'REDIS_CLUSTER_NODES',
      'DATABASE_POOL_MAX',
      'DATABASE_STATEMENT_TIMEOUT_MS',
      'SETTLEMENT_AUTHORITY_SECRET',
      // Injected by the runtime, deliberately not in the env file.
      'NODE_ENV',
      'GIT_SHA',
      'SERVICE_NAME',
      'HOST',
      'PORT',
    ]);

    const missing = [...schema].filter((name) => !example.has(name) && !optional.has(name));

    expect(missing.sort()).toEqual([]);
  });

  it('has no variable in the example that no schema reads', async () => {
    // The opposite rot: a variable that was removed from the code but lingers
    // in the example, so someone sets it and wonders why nothing happens.
    const [schema, example] = await Promise.all([schemaVars(), exampleVars()]);

    const stale = [...example].filter((name) => !schema.has(name));

    expect(stale.sort()).toEqual([]);
  });
});

describe('README claims', () => {
  it('lists every workspace app and package', async () => {
    // The layout section is the map a new contributor reads first. A package
    // missing from it is a package they do not know exists.
    const readme = await readText('README.md');
    const undocumented: string[] = [];

    for (const group of ['apps', 'packages']) {
      for (const entry of await readdir(join(ROOT, group))) {
        if (entry.startsWith('.')) continue;
        // Config-only packages are intentionally omitted from the layout tree.
        if (/-config$/.test(entry)) continue;
        if (!readme.includes(`${entry}/`)) undocumented.push(`${group}/${entry}`);
      }
    }

    expect(undocumented).toEqual([]);
  });

  it('references only scripts that exist', async () => {
    const readme = await readText('README.md');
    const pkg = JSON.parse(await readText('package.json')) as { scripts: Record<string, string> };

    const missing: string[] = [];
    for (const match of readme.matchAll(/`pnpm ([a-z][a-z0-9:]*)`/g)) {
      const name = match[1];
      if (!name) continue;
      // `pnpm install` and friends are npm builtins, not workspace scripts.
      if (['install', 'exec', 'dlx', 'add'].includes(name)) continue;
      if (!(name in pkg.scripts)) missing.push(name);
    }

    expect([...new Set(missing)].sort()).toEqual([]);
  });
});

describe('smart contract documentation', () => {
  it('documents every instruction the program exposes', async () => {
    // An undocumented instruction is an undocumented capability — and on a
    // program that moves money, that is the one thing an auditor asks about.
    const lib = await readText('programs/programs/arena/src/lib.rs');
    const doc = await readText('docs/ONCHAIN.md');

    const instructions = [...lib.matchAll(/pub fn ([a-z_]+)\s*[(<]/g)]
      .map((match) => match[1])
      .filter((name): name is string => !!name && name !== 'id');

    const undocumented = instructions.filter((name) => !doc.includes(`\`${name}\``));

    expect(undocumented.sort()).toEqual([]);
  });

  it('documents every PDA seed the program derives', async () => {
    // Seeds are mirrored in the TypeScript SDK. Drift makes every instruction
    // fail a constraint, so the doc is the place the two are reconciled.
    const constants = await readText('programs/programs/arena/src/constants.rs');
    const doc = await readText('docs/ONCHAIN.md');

    const seeds = [...constants.matchAll(/pub const [A-Z_]+_SEED: &\[u8\] = b"([a-z_]+)"/g)]
      .map((match) => match[1])
      .filter((seed): seed is string => !!seed);

    expect(seeds.length).toBeGreaterThan(0);

    const undocumented = seeds.filter((seed) => !doc.includes(`"${seed}"`));
    expect(undocumented.sort()).toEqual([]);
  });

  it('states the fee caps that the constants actually set', async () => {
    // The cap is the guarantee. A doc claiming 10% while the constant says 50%
    // is worse than silence, because it is the number a reader will quote.
    const constants = await readText('programs/programs/arena/src/constants.rs');
    const doc = await readText('docs/ONCHAIN.md');

    const feeBps = /MAX_FEE_BPS: u16 = ([0-9_]+)/.exec(constants)?.[1]?.replace(/_/g, '');
    const withdrawalBps = /MAX_WITHDRAWAL_FEE_BPS: u16 = ([0-9_]+)/
      .exec(constants)?.[1]
      ?.replace(/_/g, '');

    expect(feeBps).toBe('1000');
    expect(withdrawalBps).toBe('200');

    // 1000 bps = 10%, 200 bps = 2%. Both figures appear in the prose.
    expect(doc).toMatch(/10%/);
    expect(doc).toMatch(/200 bps|2%/);
  });
});

describe('data model documentation', () => {
  it('documents every table in the schema', async () => {
    const schema = await readText('packages/db/prisma/schema.prisma');
    const doc = await readText('docs/DATA-MODEL.md');

    // `@@map` appears on enums too; only model blocks count as tables.
    const tables = [...schema.matchAll(/^model\s+\w+\s*\{[\s\S]*?^\}/gm)]
      .map((block) => /@@map\("([a-z_]+)"\)/.exec(block[0])?.[1])
      .filter((name): name is string => !!name);

    expect(tables.length).toBeGreaterThan(10);

    const undocumented = tables.filter((table) => !doc.includes(table));
    expect(undocumented.sort()).toEqual([]);
  });
});
