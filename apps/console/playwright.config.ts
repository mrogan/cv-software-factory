/**
 * The console's browser tests, against the production build, fed from the samples' event log with no Postgres
 * behind it, and from the milestone 4 test data by a second server (the live test, which needs a store, starts
 * its own). Snapshots are taken in the pinned Playwright
 * image, so they match from one machine to the next: `make e2e` runs them there.
 */
import { defineConfig, devices } from '@playwright/test';
import { END, FIXTURE_END, FIXTURE_PORT, PORT } from './e2e/support.ts';

/** Snapshots only mean something in the pinned image (`make e2e` and CI set this); elsewhere they are skipped. */
const pinned = Boolean(process.env.SF_PINNED_BROWSER);

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  ...(process.env.CI && { workers: 2 }),
  reporter: process.env.CI ? [['github'], ['html', { open: 'never', outputFolder: 'e2e-report' }]] : 'list',
  outputDir: 'e2e-results',
  snapshotPathTemplate: '{testDir}/snapshots/{testFileName}/{arg}{ext}',
  expect: { toHaveScreenshot: { animations: 'disabled', caret: 'hide', scale: 'css' } },
  use: {
    baseURL: `http://localhost:${PORT}`,
    timezoneId: 'Europe/London',
    locale: 'en-GB',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'console',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: pinned ? /(live|speed)\.spec\.ts/ : /(live|speed|visual)\.spec\.ts/,
    },
    { name: 'live', use: { ...devices['Desktop Chrome'] }, testMatch: /live\.spec\.ts/ },
    // Timed alone, once everything else has finished, so other tests' browsers don't share its CPU.
    { name: 'speed', testMatch: /speed\.spec\.ts/, dependencies: ['console', 'live'] },
  ],
  webServer: [
    { port: PORT, log: '../../packages/samples/log', now: END },
    { port: FIXTURE_PORT, log: 'test/fixture/log', now: FIXTURE_END },
  ].map(({ port, log, now }) => ({
    command: 'node src/server.ts',
    url: `http://localhost:${port}/health`,
    env: {
      PORT: String(port),
      EVENT_LOG: log,
      EVENT_LOG_NOW: new Date(now).toISOString(),
      NODE_ENV: 'production',
      LOG_LEVEL: 'silent',
      OTEL_SDK_DISABLED: 'true',
    },
    reuseExistingServer: false,
  })),
});
