/**
 * What every browser test shares: the widths and themes it runs at, the samples' last moment to pin the time to,
 * the milestone 4 test data's server and moments, and a guard that fails a test on any content security policy
 * violation or request to another origin.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page } from '@playwright/test';

export const PORT = 18_321;
/** A second server, with the console's milestone 4 test data (test/fixture) instead of the samples. */
export const FIXTURE_PORT = 18_322;
const FIXTURE_ORIGIN = `http://localhost:${FIXTURE_PORT}`;

const log = fileURLToPath(new URL('../../../packages/samples/log/events.ndjson', import.meta.url));
const lines = readFileSync(log, 'utf-8').trim().split('\n');

/** When the samples' last event happened: the server is told it is now, and pages pin t to it. */
export const END = Date.parse((JSON.parse(lines.at(-1) ?? '{}') as { ts: string }).ts);

const fixtureLog = fileURLToPath(new URL('../test/fixture/log/events.ndjson', import.meta.url));
const fixtureLines = readFileSync(fixtureLog, 'utf-8').trim().split('\n');

/** When the test data's last event happened: its server is told it is now. */
export const FIXTURE_END = Date.parse((JSON.parse(fixtureLines.at(-1) ?? '{}') as { ts: string }).ts);

/** Moments in the test data's day, in London: the afternoon's work done, the cap reached, and the cap cleared. */
export const MOMENTS = {
  afternoon: '2026-10-03T16:10:00+01:00',
  capped: '2026-10-03T21:20:00+01:00',
  cleared: '2026-10-04T01:05:00+01:00',
} as const;

/** The console showing the test data at one of its moments, with motion off. */
export function fixtureUrl({
  at = 'afternoon',
  theme = 'paper',
  item,
  sheet = false,
}: {
  at?: keyof typeof MOMENTS;
  theme?: 'paper' | 'ink';
  item?: string;
  sheet?: boolean;
} = {}): string {
  const params = new URLSearchParams({ t: MOMENTS[at], theme, motion: 'off' });
  if (item) params.set('item', item);
  if (sheet) params.set('sheet', '');
  return `${FIXTURE_ORIGIN}/?${params}`;
}

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

/**
 * An empty store of a given kind: no events, and a stream that opens, says what the store holds as the server's
 * does (test/app.test.ts checks the server's side), and then stays open with nothing more to say.
 */
export async function emptyStore(page: Page, kind: 'sample' | 'real' | null): Promise<void> {
  await page.route('**/api/events?after=0', (route) => route.fulfill({ json: [] }));
  await page.addInitScript((kind) => {
    class Quiet extends EventTarget {
      static readonly CLOSED = 2;
      readyState = 1;
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor() {
        super();
        setTimeout(() => {
          this.onopen?.(new Event('open'));
          this.dispatchEvent(new MessageEvent('store', { data: JSON.stringify({ kind }) }));
        }, 0);
      }
      close() {
        this.readyState = 2;
      }
    }
    (globalThis as { EventSource: unknown }).EventSource = Quiet;
  }, kind);
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
      const origins = [new URL(baseURL ?? '').origin, FIXTURE_ORIGIN];
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
        if (!['data:', 'blob:'].includes(url.protocol) && !origins.includes(url.origin))
          guard.foreign.push(request.url());
      });
      await use(guard);
      expect(guard.violations, 'content security policy violations').toEqual([]);
      expect(guard.foreign, 'requests to another origin').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
