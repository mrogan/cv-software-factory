/**
 * A sense that looks at the app through a browser: it runs each of its checks on a page of its own, and watches the
 * page while it does. A check says what it set out to find. Whatever else went wrong on the pages it opened is also
 * found, by the same watch, whichever check opened them:
 *
 * - `<check>/console`: the browser's console reported an error, or the page threw;
 * - `<check>/server-error`: the app answered a request with a 5xx;
 * - `<check>/broken-image`: an image did not load, or was not an image.
 *
 * Each of those is a check in its own right, so passing resets its streak, as it should. A finding keeps a screenshot
 * of the page it was made on, with the boxes the check asked for, and a short text of what was expected and seen.
 */
import type { ArtifactRef, Evidence } from '@software-factory/events';
import type { ArtifactStore } from '@software-factory/store';
import { type Browser, type BrowserContext, chromium, type Page, type Request, type Response } from 'playwright';
import { capture } from '../capture.ts';
import { evidenceOf, pathOf } from './http.ts';
import { type Finding, Found, type Observation, type Sense } from './types.ts';

/** What a check is given: the app, the page to use, and what the sense shares between checks in one pass. */
export interface CheckContext<Shared> {
  /** The app's address, with no path. */
  app: string;
  version: string;
  page: Page;
  shared: Shared;
}

export interface BrowserCheck<Shared> {
  id: string;
  /** The route as the app names it, such as `/products/:slug`. */
  route: string;
  /** Null when the check passed. It throws when it could not tell. */
  run(context: CheckContext<Shared>): Promise<Finding | null>;
}

export interface BrowserSenseOptions<Shared> {
  name: Sense['name'];
  app: string;
  checks: readonly BrowserCheck<Shared>[];
  store: ArtifactStore;
  /** Made once for each pass: what the checks share, such as what the app's API says. */
  shared: () => Shared;
  log: { warn(fields: object, message: string): void };
  launch?: () => Promise<Browser>;
  /** The longest one check may take, in milliseconds. */
  timeout?: number;
}

export class BrowserSense<Shared> implements Sense {
  readonly name: Sense['name'];
  private readonly options: BrowserSenseOptions<Shared>;
  private browser: Browser | undefined;

  constructor(options: BrowserSenseOptions<Shared>) {
    this.options = options;
    this.name = options.name;
  }

  async pass(version: string): Promise<Observation[]> {
    this.browser ??= await (this.options.launch ?? (() => chromium.launch()))();
    const context = await this.browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-GB' });
    const shared = this.options.shared();
    const observations: Observation[] = [];
    try {
      for (const check of this.options.checks) observations.push(...(await this.look(check, context, version, shared)));
    } finally {
      await context.close();
    }
    return observations;
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = undefined;
  }

  private async look(
    check: BrowserCheck<Shared>,
    context: BrowserContext,
    version: string,
    shared: Shared,
  ): Promise<Observation[]> {
    const { app } = this.options;
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const watch = watching(page, new URL(app).origin);
    let finding: Finding | null = null;
    let trouble: string | undefined;
    try {
      finding = await within(this.options.timeout ?? 120_000, check.run({ app, version, page, shared }));
    } catch (error) {
      if (error instanceof Found) finding = error.finding;
      else trouble = (error instanceof Error ? error.message : String(error)).split('\n')[0];
    }
    const { console, serverErrors, brokenImages } = await watch.finish();
    const route = check.route;
    const [error] = serverErrors;
    const [image] = brokenImages;
    /** Each result, with the page it was seen on when that is not the one the check ended on. */
    const results: Array<{ id: string; finding: Finding | null; at?: string }> = [
      { id: check.id, finding },
      {
        id: `${check.id}/console`,
        finding: console.length
          ? {
              symptom: 'browser-error',
              message: `The browser reported ${console.length === 1 ? 'an error' : `${console.length} errors`} while the page was used: ${console[0]?.text}`,
              evidence: [
                {
                  kind: 'console',
                  route,
                  version,
                  messages: console
                    .slice(0, 20)
                    .map(({ level, text, source }) => ({ level, text, ...(source && { source }) })),
                },
              ],
            }
          : null,
        ...(console[0] && { at: console[0].page }),
      },
      {
        id: `${check.id}/server-error`,
        finding: error
          ? {
              symptom: 'server-error',
              message: `The app answered ${error.path} with ${error.status}.`,
              evidence: serverErrors.slice(0, 3).map((e) => e.evidence),
            }
          : null,
        ...(error && { at: error.page }),
      },
      {
        id: `${check.id}/broken-image`,
        finding: image
          ? {
              symptom: 'broken-image',
              message: `An image did not load: ${image.path} ${image.reason}.`,
              evidence: brokenImages.slice(0, 3).map((e) => e.evidence),
              look: [{ selector: `img[src$="${image.path.replaceAll('"', '')}"]`, kind: 'problem' }],
            }
          : null,
        ...(image && { at: image.page }),
      },
    ];

    const observations: Observation[] = [];
    for (const { id, finding: found, at } of results) {
      observations.push({
        check: id,
        route: found?.route ?? route,
        finding: found,
        artifacts: found ? await this.keep(page, found, found.route ?? route, version, at) : [],
        // A check that ended in trouble cannot be said to have passed, whatever else it did not see.
        ...(trouble && !found && { trouble }),
      });
    }
    await page.close().catch(() => {});
    return observations;
  }

  /** Keeps the proof of a finding: a screenshot of the page it was seen on, and what was expected and seen. */
  private async keep(page: Page, found: Finding, route: string, version: string, at?: string): Promise<ArtifactRef[]> {
    const { store } = this.options;
    const artifacts: ArtifactRef[] = [];
    // The check is over: an element it looked at that is not on this page should not be waited for.
    page.setDefaultTimeout(2_000);
    try {
      // A finding from the watch was seen on some page the check opened earlier, so go back to it.
      if (at && page.url() !== at) await page.goto(at, { waitUntil: 'load', timeout: 10_000 });
      const look = (found.look ?? []).slice(0, 4);
      for (const box of look)
        await page
          .locator(box.selector)
          .first()
          .scrollIntoViewIfNeeded({ timeout: 2_000 })
          .catch(() => {});
      artifacts.push(
        await capture(page, store, { route, version, checks: look }).catch((error) => {
          this.options.log.warn(
            { err: String(error), route },
            'the boxes did not fit the screenshot; taking it without',
          );
          return capture(page, store, { route, version });
        }),
      );
    } catch (error) {
      this.options.log.warn({ err: String(error), route }, 'no screenshot of a finding');
    }
    const text = Buffer.from(`${found.message}\n`);
    artifacts.push({
      kind: 'file',
      hash: await store.put(text),
      type: 'text/plain',
      size: text.byteLength,
      name: 'finding.txt',
    });
    return artifacts;
  }
}

/** Rejects when the work takes longer than the limit. */
async function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`took longer than ${Math.round(ms / 1000)} s`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Listens to a page for what a visitor would suffer without being asked about it. */
function watching(page: Page, origin: string) {
  const consoleErrors: Array<{ level: 'error'; text: string; source?: string; page: string }> = [];
  const serverErrors: Array<{ path: string; status: number; evidence: Evidence; page: string }> = [];
  const brokenImages: Array<{ path: string; reason: string; evidence: Evidence; page: string }> = [];

  const onConsole = (message: { type(): string; text(): string; location(): { url: string; lineNumber: number } }) => {
    // The browser also reports each failed request here; those are found below, with more to say about them.
    if (message.type() !== 'error' || message.text().startsWith('Failed to load resource')) return;
    const { url, lineNumber } = message.location();
    consoleErrors.push({
      level: 'error',
      text: message.text().trim().slice(0, 300),
      ...(url && { source: `${pathOf(url).split('?')[0]}:${lineNumber}`.slice(0, 300) }),
      page: page.url(),
    });
  };
  const onPageError = (error: Error) =>
    consoleErrors.push({ level: 'error', text: `Uncaught ${error.message}`.slice(0, 300), page: page.url() });
  const onResponse = async (response: Response) => {
    // Remember the page now: by the time the headers are read the browser may have moved on.
    const on = page.url();
    if (new URL(response.url()).origin !== origin) return;
    const request = response.request();
    const status = response.status();
    const type = (await response.headerValue('content-type').catch(() => null)) ?? '';
    const isImage = request.resourceType() === 'image';
    const broken = isImage && (status >= 400 || (status < 300 && !type.startsWith('image/')));
    if (status < 500 && !broken) return;
    const evidence = await evidenceOf(response).catch(() => null);
    if (!evidence) return;
    const path = pathOf(response.url());
    if (status >= 500) serverErrors.push({ path, status, evidence, page: on });
    if (broken) {
      const reason = status >= 400 ? `answered ${status}` : `answered with ${type || 'no type'}, not an image`;
      brokenImages.push({ path: path.split('?')[0] ?? path, reason, evidence, page: on });
    }
  };
  const onFailed = (request: Request) => {
    const reason = request.failure()?.errorText ?? '';
    if (request.resourceType() !== 'image' || new URL(request.url()).origin !== origin || reason.includes('ABORTED'))
      return;
    const path = pathOf(request.url());
    brokenImages.push({
      path: path.split('?')[0] ?? path,
      reason: `failed (${reason})`,
      evidence: {
        kind: 'http',
        method: 'GET',
        url: path,
        status: null,
        headers: {},
        timings: { firstByteMs: 0, totalMs: 0 },
        redirects: [],
      },
      page: page.url(),
    });
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  const pending = new Set<Promise<void>>();
  const onResponseSoon = (response: Response) => {
    const work: Promise<void> = onResponse(response).finally(() => pending.delete(work));
    pending.add(work);
  };
  page.on('response', onResponseSoon);
  page.on('requestfailed', onFailed);
  return {
    /** Stops listening, once the responses already heard of have been read. */
    finish: async () => {
      await Promise.all(pending);
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
      page.off('response', onResponseSoon);
      page.off('requestfailed', onFailed);
      return { console: consoleErrors, serverErrors, brokenImages };
    },
  };
}
