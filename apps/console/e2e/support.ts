/**
 * What every browser test shares: the widths and themes it runs at, the samples' last moment to pin the time to,
 * and a guard that fails a test on any content security policy violation or request to another origin.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page } from '@playwright/test';

export const PORT = 18_321;

const log = fileURLToPath(new URL('../../../packages/samples/log/events.ndjson', import.meta.url));
const lines = readFileSync(log, 'utf-8').trim().split('\n');

/** When the samples' last event happened: the server is told it is now, and pages pin t to it. */
export const END = Date.parse((JSON.parse(lines.at(-1) ?? '{}') as { ts: string }).ts);

export const WIDTHS = {
  phone: { width: 390, height: 844 },
  laptop: { width: 1024, height: 768 },
  desktop: { width: 1440, height: 900 },
};
export const THEMES = ['paper', 'ink'] as const;

/** The console at the samples' last moment, with motion off unless asked for. */
export function consoleUrl({
  theme = 'paper',
  motion = false,
  item,
  sheet = false,
  debug,
}: {
  theme?: 'paper' | 'ink';
  motion?: boolean;
  item?: string | undefined;
  sheet?: boolean;
  debug?: string;
} = {}): string {
  const params = new URLSearchParams({ t: new Date(END).toISOString(), theme });
  if (!motion) params.set('motion', 'off');
  if (item) params.set('item', item);
  if (sheet) params.set('sheet', '');
  if (debug) params.set('debug', debug);
  return `/?${params}`;
}

export async function ready(page: Page): Promise<void> {
  await page.locator('.card[data-place="centre"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
}

interface Guard {
  violations: string[];
  foreign: string[];
}

/** Every test fails on a policy violation or a request to another origin, whatever else it checks. */
export const test = base.extend<{ guard: Guard }>({
  guard: [
    async ({ page, baseURL }, use) => {
      const guard: Guard = { violations: [], foreign: [] };
      const origin = new URL(baseURL ?? '').origin;
      await page.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (event) => {
          console.error(`CSP violation: ${event.violatedDirective} ${event.blockedURI}`);
        });
      });
      page.on('console', (message) => {
        if (message.text().startsWith('CSP violation') || message.text().includes('Content Security Policy')) {
          guard.violations.push(message.text());
        }
      });
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (!['data:', 'blob:'].includes(url.protocol) && url.origin !== origin) guard.foreign.push(request.url());
      });
      await use(guard);
      expect(guard.violations, 'content security policy violations').toEqual([]);
      expect(guard.foreign, 'requests to another origin').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
