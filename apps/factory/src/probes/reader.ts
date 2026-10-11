/**
 * The page reader, for triage: it is given the path of a page of the app, and says what the page looks like and
 * what it says. A screenshot goes in the artifact store; the visible text comes back as passages for Jev to choose
 * from. The text of a page is never logged. Beside it, for the line's Verify, a ticket's check run again
 * (`verify.ts`).
 *
 *     POST /v1/pages   { "path": "/about" }  ->  { "screenshot": <Screenshot>, "passages": ["…"] }
 *     POST /v1/verify  { "sense", "check", "route" }  ->  202 while it runs, then { "outcome", "version", "runs", … }
 *     GET  /health
 */
import { createServer, type Server } from 'node:http';
import type { ArtifactStore } from '@software-factory/store';
import { capture } from '../capture.ts';
import type { BrowserSense } from '../senses/browser.ts';
import { type VerifyRequest, type VerifyStatus, verifyRequest } from './verify.ts';

export const MAX_PASSAGES = 40;
export const MAX_PASSAGE_LENGTH = 200;

/** Splits a page's text into passages of a sentence or so, in order, each cut to length, with no repeats. */
export function passagesOf(text: string): string[] {
  const seen = new Set<string>();
  const passages: string[] = [];
  for (const line of text.split(/\n+/)) {
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      const passage = sentence.replace(/\s+/g, ' ').trim().slice(0, MAX_PASSAGE_LENGTH).trim();
      if (!passage || seen.has(passage)) continue;
      seen.add(passage);
      passages.push(passage);
      if (passages.length === MAX_PASSAGES) return passages;
    }
  }
  return passages;
}

/** A path of the app, and nothing else: no host, no query, no fragment. Null if it is anything more. */
export function pathOnly(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 200) return null;
  if (!/^\/(?!\/)[^\s?#\\]*$/.test(value)) return null;
  return value;
}

export interface ReaderOptions {
  app: string;
  sense: Pick<BrowserSense<unknown>, 'withPage'>;
  store: ArtifactStore;
  /** The app's version now. */
  version(): Promise<string>;
  log: { info(fields: object, message: string): void; warn(fields: object, message: string): void };
  /**
   * Starts a ticket's check again against the app, or says how the one started is going (`Verifications`); without
   * it, the worker verifies nothing.
   */
  verify?: (request: VerifyRequest) => VerifyStatus | Promise<VerifyStatus>;
}

export function readerServer({ app, sense, store, version, log, verify }: ReaderOptions): Server {
  return createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'GET' && req.url === '/health') return reply(200, { status: 'ok' });
      const verifying = req.url === '/v1/verify' && verify !== undefined;
      if (req.method !== 'POST' || (req.url !== '/v1/pages' && !verifying)) return reply(404, { error: 'not found' });
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 1_000) return reply(413, { error: 'too large' });
      }
      if (verifying) {
        let asked: ReturnType<typeof verifyRequest.safeParse>;
        try {
          asked = verifyRequest.safeParse(JSON.parse(raw));
        } catch {
          return reply(400, { error: 'the body is not JSON' });
        }
        if (!asked.success) return reply(400, { error: 'a verification names a sense, a check and a route' });
        const status = await verify(asked.data);
        if (status.state === 'running') return reply(202, { state: 'running' });
        const { answer } = status;
        log.info({ ...asked.data, outcome: answer.outcome, runs: answer.runs }, 'a check was run again');
        return reply(200, answer);
      }
      let path: string | null = null;
      try {
        path = pathOnly((JSON.parse(raw) as { path?: unknown }).path);
      } catch {
        // Not JSON: refused below with the rest.
      }
      if (!path)
        return reply(400, { error: 'path must be a path of the app, starting with / and with no query or fragment' });
      const started = Date.now();
      const current = await version();
      const page = await sense.withPage(async (page) => {
        const response = await page.goto(new URL(path, app).href, { waitUntil: 'load' });
        const main = page.locator('main').first();
        const text = await ((await main.count()) ? main : page.locator('body')).innerText();
        return {
          status: response?.status() ?? null,
          text,
          screenshot: await capture(page, store, { route: path, version: current }),
        };
      });
      log.info({ path, status: page.status, ms: Date.now() - started }, 'a page was read');
      return reply(200, { screenshot: page.screenshot, passages: passagesOf(page.text) });
    } catch (error) {
      log.warn(
        { err: error instanceof Error ? error.message.split('\n')[0] : String(error) },
        req.url === '/v1/verify' ? 'a check could not be run again' : 'a page could not be read',
      );
      return reply(502, {
        error: req.url === '/v1/verify' ? 'the check could not be run' : 'the page could not be read',
      });
    }
  });
}
