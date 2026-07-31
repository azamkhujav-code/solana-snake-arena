import { describe, expect, it } from 'vitest';

/**
 * Pins the adapter behaviour that made "select Phantom, nothing happens" a bug
 * rather than an environment problem.
 *
 * `WalletProvider`'s `autoConnect` calls `adapter.autoConnect()` on selection.
 * For a legacy adapter that forwards to `connect()`. For `StandardWalletAdapter`
 * — which is what Phantom actually resolves to, since it registers through the
 * Wallet Standard — it is `connect({ silent: true })`, and `silent` means never
 * prompt. On a first connection that is a no-op with no error, because
 * declining to prompt is not a failure.
 *
 * These read the installed library source. That is unusual for a test, and
 * deliberate: the behaviour lives in a dependency, a patch release could change
 * it, and the failure mode is a button that does nothing — which no assertion
 * about our own code would catch.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Walks up to the workspace root, where pnpm keeps its store. */
function workspaceRoot(): string {
  let dir = import.meta.dirname;

  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'node_modules', '.pnpm'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('Could not find node_modules/.pnpm above ' + import.meta.dirname);
}

/**
 * The text following an `autoConnect()` declaration.
 *
 * A fixed window rather than brace matching: the compiled output wraps bodies
 * in `__awaiter(...)`, so the first `}` closes the generator, not the method.
 */
function autoConnectBody(source: string): string {
  const index = source.indexOf('autoConnect()');
  return index === -1 ? '' : source.slice(index, index + 400);
}

function findLibrarySource(globPattern: string): string {
  const root = workspaceRoot();
  const found = execSync(`find node_modules/.pnpm -path "${globPattern}" | head -1`, {
    encoding: 'utf8',
    cwd: root,
  }).trim();

  if (!found) throw new Error(`Could not locate ${globPattern}`);
  return readFileSync(resolve(root, found), 'utf8');
}

describe('wallet adapter autoConnect semantics', () => {
  it('StandardWalletAdapter.autoConnect connects silently, so it cannot prompt', () => {
    const source = findLibrarySource(
      '*/@solana+wallet-standard-wallet-adapter-base@*/**/lib/cjs/adapter.js',
    );

    // The line that makes an explicit `connect()` necessary. If a future
    // version drops `silent`, `useWalletConnect` becomes redundant — and this
    // test failing is how anyone would find that out.
    expect(autoConnectBody(source)).toContain('silent');
  });

  it('WalletProvider routes selection through autoConnect, not connect', () => {
    const source = findLibrarySource(
      '*/@solana+wallet-adapter-react@*/**/lib/cjs/WalletProvider.js',
    );

    // `adapter.autoConnect()` is what runs when a wallet is selected. Nothing
    // in the provider calls `adapter.connect()` on the user's behalf, which is
    // why the app has to.
    expect(source).toContain('adapter.autoConnect()');
  });

  it('the legacy adapter would have worked, which is why this looked like an environment bug', () => {
    // BaseWalletAdapter.autoConnect forwards to connect(), so a wallet that is
    // *not* Wallet Standard connects fine on selection. That difference is the
    // whole reason this reproduced for Phantom and not in a bare test.
    const source = findLibrarySource('*/@solana+wallet-adapter-base@*/**/lib/cjs/adapter.js');
    const body = autoConnectBody(source);

    expect(body).toContain('this.connect()');
    expect(body).not.toContain('silent');
  });
});
