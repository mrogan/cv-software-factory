/**
 * The console's browser tests, against the production build, fed from the samples' event log with no Postgres
 * behind it (the live test, which needs a store, starts its own). Snapshots are taken in the pinned Playwright
 * image, so they match from one machine to the next: `make e2e` runs them there.
 */
import { defineConfig, devices } from '@playwright/test';
import { END, PORT } from './e2e/support.ts';

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
      testIgnore: pinned ? /live\.spec\.ts/ : /(live|visual)\.spec\.ts/,
    },
    { name: 'live', use: { ...devices['Desktop Chrome'] }, testMatch: /live\.spec\.ts/ },
  ],
  webServer: {
    command: 'node src/server.ts',
    url: `http://localhost:${PORT}/health`,
    env: {
      PORT: String(PORT),
      EVENT_LOG: '../../packages/samples/log',
      EVENT_LOG_NOW: new Date(END).toISOString(),
      NODE_ENV: 'production',
      LOG_LEVEL: 'silent',
      OTEL_SDK_DISABLED: 'true',
    },
    reuseExistingServer: false,
  },
});
