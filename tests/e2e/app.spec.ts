import { expect, test, type Page } from '@playwright/test';

/**
 * End-to-end coverage of the app with no backend reachable.
 *
 * That is not a limitation being worked around — it is a state real users hit
 * whenever the API has a bad minute, and the client's behaviour in it is
 * otherwise untested. A page that renders blank, spins forever, or throws an
 * unhandled rejection when a fetch fails is broken in a way no unit test sees,
 * because unit tests resolve their mocks.
 */

/** Collects page errors and console errors for the life of a page. */
function watchForErrors(page: Page): { errors: string[] } {
  const errors: string[] = [];

  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;

    const text = message.text();
    // Failed network requests are the expected condition here — the whole
    // point is that the backend is down. Anything else is a real defect.
    if (/Failed to load resource|net::ERR_|ERR_CONNECTION/.test(text)) return;
    errors.push(`console: ${text}`);
  });

  return { errors };
}

const PAGES = [
  { path: '/', name: 'home' },
  { path: '/play', name: 'play' },
  { path: '/leaderboard', name: 'leaderboard' },
  { path: '/profile', name: 'profile' },
  { path: '/admin', name: 'admin' },
] as const;

test.describe('rendering', () => {
  for (const { path, name } of PAGES) {
    test(`${name} renders without throwing`, async ({ page }) => {
      const watcher = watchForErrors(page);

      const response = await page.goto(path);
      expect(response?.status(), `${path} should not be a server error`).toBeLessThan(400);

      // `domcontentloaded` rather than `networkidle`: with the API down there
      // is no idle to wait for, and `networkidle` would time out on every page.
      await page.waitForLoadState('domcontentloaded');

      // Something must actually be on screen. A page that mounts and then
      // unmounts on a failed fetch leaves a technically-200 blank document.
      const body = await page.locator('body').innerText();
      expect(body.trim().length, `${path} rendered an empty body`).toBeGreaterThan(0);

      expect(watcher.errors, `${path} logged errors`).toEqual([]);
    });
  }

  test('unknown routes render the not-found page rather than crashing', async ({ page }) => {
    const response = await page.goto('/definitely-not-a-real-page');

    expect(response?.status()).toBe(404);
    await expect(page.locator('body')).not.toBeEmpty();
  });
});

test.describe('navigation', () => {
  test('moves between pages without a full reload', async ({ page }) => {
    await page.goto('/');

    // Client-side routing is what makes the app feel instant; if it falls back
    // to a document navigation the game canvas is torn down and rebuilt.
    await page.evaluate(() => {
      (window as unknown as { __navMarker?: boolean }).__navMarker = true;
    });

    const link = page.locator('a[href="/leaderboard"]').first();
    if ((await link.count()) === 0) test.skip(true, 'no leaderboard link on the home page');

    await link.click();
    await page.waitForURL('**/leaderboard');

    const survived = await page.evaluate(
      () => (window as unknown as { __navMarker?: boolean }).__navMarker === true,
    );
    expect(survived, 'navigation reloaded the document instead of routing client-side').toBe(true);
  });

  test('the admin console is excluded from indexing', async ({ page }) => {
    // Not a security control — the gateway's role guard is — but the operator
    // console has no business in search results.
    await page.goto('/admin');

    const robots = await page.locator('meta[name="robots"]').getAttribute('content');
    expect(robots).toContain('noindex');
  });
});

test.describe('degradation without a backend', () => {
  test('the admin console asks for sign-in rather than hanging', async ({ page }) => {
    await page.goto('/admin');

    // The honest state: no session, so say so. An infinite spinner would leave
    // an operator unable to tell "loading" from "broken".
    await expect(page.getByText(/sign in/i).first()).toBeVisible({ timeout: 10_000 });
  });

  test('no page leaves an unhandled promise rejection', async ({ page }) => {
    // The failure mode a fetch-without-catch produces. It is invisible in the
    // UI and takes down error budgets via Sentry noise.
    const rejections: string[] = [];
    page.on('pageerror', (error) => rejections.push(error.message));

    for (const { path } of PAGES) {
      await page.goto(path);
      await page.waitForTimeout(1_000);
    }

    expect(rejections).toEqual([]);
  });

  test('the play page does not spin forever on a dead API', async ({ page }) => {
    await page.goto('/play');
    await page.waitForTimeout(3_000);

    const text = await page.locator('body').innerText();
    // Either room content or an honest failure message — but not an empty
    // shell, which is what "loading" looks like after it gives up silently.
    expect(text.trim().length).toBeGreaterThan(0);
  });
});

test.describe('no wallet extension', () => {
  // Playwright runs a bare Chromium, so this is the real state of a browser
  // with no Solana wallet — the one case in the wallet flow that *can* be
  // covered end to end here.
  //
  // The two projects legitimately diverge, because "no extension" does not mean
  // "no wallet" on a phone. Phantom's adapter reports `Loadable` on a mobile
  // user agent: it deep-links into the installed app rather than injecting a
  // provider. So the connect button really does work there, and an install link
  // would be the wrong advice. Asserting one behaviour for both viewports would
  // force the code to be wrong on one of them.
  test('offers an install link rather than a picker that cannot work', async ({
    page,
  }, testInfo) => {
    await page.goto('/');

    const installLink = page.getByRole('link', { name: /install phantom/i });
    const connectButton = page.getByRole('button', { name: /^connect wallet$/i });

    // Exactly one of each, wherever it lives. Two "Install Phantom" links on one
    // screen is what this caught the first time, and it was a real defect: the
    // header and the entry panel were both offering the same first step.
    await expect(page.getByTestId('enter-arena')).toBeVisible({ timeout: 10_000 });

    // The nickname comes first, so until one is typed the button says so rather
    // than offering a wallet. Walking the real order is also the only way to
    // reach the connect step at all.
    await page.getByPlaceholder(/snake/i).fill('Tester');

    if (testInfo.project.name === 'mobile') {
      // A deep link is a real path to a wallet, so offer it.
      await expect(connectButton).toHaveCount(1);
      await expect(installLink).toHaveCount(0);
      return;
    }

    await expect(installLink).toHaveCount(1);
    await expect(installLink).toBeVisible();

    // The picker must not be offered: clicking it would list Phantom, accept
    // the click, and do nothing — which reads as a broken button.
    await expect(connectButton).toHaveCount(0);
  });
});

test.describe('responsive layout', () => {
  test('never scrolls the body horizontally', async ({ page }) => {
    // A horizontally-scrolling body is the classic mobile layout bug, and it is
    // invisible on a desktop viewport.
    for (const { path } of PAGES) {
      await page.goto(path);
      await page.waitForLoadState('domcontentloaded');

      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      expect(overflows, `${path} scrolls horizontally`).toBe(false);
    }
  });

  test('renders a viewport meta tag', async ({ page }) => {
    await page.goto('/');

    const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
    expect(viewport).toContain('width=device-width');
  });
});

test.describe('backend-dependent', () => {
  // Skipped unless a stack is up. Tagged rather than deleted so the coverage
  // exists the moment someone runs `docker compose up`.
  test.skip(process.env.E2E_BACKEND !== '1', 'requires a running gateway');

  test('@backend the leaderboard loads real entries', async ({ page }) => {
    await page.goto('/leaderboard');
    await expect(page.getByRole('table')).toBeVisible({ timeout: 10_000 });
  });

  test('@backend the room board is hidden until a wallet is connected', async ({ page }) => {
    // Room selection is on the landing page; `/play` is the game canvas.
    //
    // Entry fees are paid per match straight from the wallet, so a board
    // nobody can buy into is not worth showing. The gate is a session *and* a
    // connected wallet — checking only the session was a real bug, because the
    // session comes back by itself after a reload (its refresh token is a
    // cookie) while the wallet connection does not.
    await page.goto('/');

    await expect(page.getByTestId('enter-arena')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('room-card')).toHaveCount(0);
    await expect(page.getByPlaceholder(/snake/i)).toBeVisible();
    await expect(page.locator('[data-testid="room-card"]')).toHaveCount(0);
  });
});
