/**
 * The console's browser tests, against the production build, fed from the samples' event log with no Postgres
 * behind it (the live test, which needs a store, starts its own). Snapshots are taken in the pinned Playwright
 * image, so they match from one machine to the next: `make e2e` runs them there.
 */
import { defineConfig, devices } from '@playwright/test';
import { END, PORT } from './e2e/support.ts';

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  workers: process.env.CI ? 2 : undefined,
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
    { name: 'console', use: { ...devices['Desktop Chrome'] }, testIgnore: /live\.spec\.ts/ },
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
