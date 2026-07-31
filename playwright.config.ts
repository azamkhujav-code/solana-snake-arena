import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the real Next.js app in a real browser.
 *
 * **The gateway is not running.** These tests deliberately cover what the app
 * does without a backend, which is a larger and more interesting surface than
 * it sounds: every page must render, navigate, and degrade honestly when the
 * API is unreachable. "The API is down" is a state real users hit, and a client
 * that renders a blank screen or an infinite spinner in that state is broken in
 * a way no unit test notices.
 *
 * Tests requiring a live backend are tagged `@backend` and skipped unless
 * `E2E_BACKEND=1` is set, so the suite stays runnable in CI without
 * infrastructure rather than being disabled wholesale.
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './tests/e2e/.artifacts',

  // Serial by default: these share one dev server, and a parallel run makes a
  // console-error assertion pick up noise from a different test's page.
  fullyParallel: false,
  workers: 1,

  // A flaky E2E test is worse than none — it trains everyone to re-run. One
  // retry catches genuine port/startup races without hiding real flakiness.
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,

  timeout: 30_000,
  expect: { timeout: 5_000 },

  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // Mobile is a first-class target for this game, and the touch layout is
    // where a viewport bug actually shows up.
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],

  webServer: {
    /**
     * The production build, not `next dev`.
     *
     * Dev mode has different error handling and hydration behaviour, so testing
     * it tests something users never run.
     *
     * `next start` rather than the standalone server despite `output:
     * 'standalone'` in the Next config — the standalone bundle needs `.next/static`
     * and `public/` copied alongside it, which is a deploy step, not a test one.
     * Next prints a warning about the mismatch; it serves correctly regardless,
     * and the alternative is duplicating the Docker copy steps here where they
     * would silently rot.
     */
    command: `pnpm --filter @arena/web exec next start --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
