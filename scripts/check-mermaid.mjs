#!/usr/bin/env node
/**
 * Parses every Mermaid diagram in the docs with the real Mermaid parser.
 *
 *   node scripts/check-mermaid.mjs
 *
 * A diagram with a syntax error renders as a red error box in the middle of the
 * page, and nothing else signals it: the surrounding markdown is perfectly
 * valid, so no linter, build or link checker notices.
 *
 * Runs as a plain Node script rather than inside Vitest, and installs a jsdom
 * global before importing Mermaid. Mermaid sanitises HTML in node labels
 * through DOMPurify, which needs a real `window` — any diagram containing a
 * `<br/>` fails without one, while simple diagrams pass, so the absence is easy
 * to miss until exactly the diagrams worth having break.
 *
 * `docs.test.ts` spawns this and asserts the exit code, keeping one mechanism
 * rather than a cheap approximation in the test and the real check elsewhere.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Must be installed before Mermaid is imported: DOMPurify captures `window` at
// module-evaluation time, so a later assignment is too late.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.DOMParser = dom.window.DOMParser;
globalThis.Node = dom.window.Node;
globalThis.Element = dom.window.Element;

const mermaidModule = await import('mermaid');
const mermaid = mermaidModule.default ?? mermaidModule;

async function docFiles() {
  const files = ['README.md', 'CONTRIBUTING.md'];

  for (const entry of await readdir(join(ROOT, 'docs'))) {
    if (entry.endsWith('.md')) files.push(join('docs', entry));
  }

  return files;
}

const failures = [];
let parsed = 0;

for (const file of await docFiles()) {
  const content = await readFile(join(ROOT, file), 'utf8');

  for (const match of content.matchAll(/```mermaid\n([\s\S]*?)```/g)) {
    // Line number, so a failure names the diagram rather than just the file.
    const line = content.slice(0, match.index ?? 0).split('\n').length;

    try {
      await mermaid.parse(match[1] ?? '');
      parsed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${file}:${line}\n    ${message.split('\n').slice(0, 3).join('\n    ')}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`${failures.length} Mermaid diagram(s) failed to parse:\n`);
  for (const failure of failures) console.error(`  ${failure}\n`);
  process.exit(1);
}

// Guard against a regex that silently matched nothing, which would make this
// check pass while verifying precisely zero diagrams.
if (parsed === 0) {
  console.error('No Mermaid diagrams found — the extraction pattern is broken.');
  process.exit(1);
}

console.log(`${parsed} Mermaid diagrams parsed.`);
