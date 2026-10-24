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
 *
 * Asked to (`device`), it also says, on each check's observation, what the check's pages left on the device that no
 * check before it in the pass had (a cookie, local or session storage, IndexedDB, Cache Storage or a service worker)
 * and which other origins they asked. The gates ask, to fail a change that starts to keep anything on a visitor's
 * device or to send them elsewhere (`senses/observe.ts`); the senses that look after the live app do not.
 */
import type { ArtifactRef, Evidence } from '@software-factory/events';
import type { ArtifactStore } from '@software-factory/store';
import { type Browser, type BrowserContext, chromium, type Page, type Request, type Response } from 'playwright';
import { capture } from '../capture.ts';
import { evidenceOf, pathOf, type RequestHeaders } from './http.ts';
import { type Device, type Finding, Found, type Observation, type Sense } from './types.ts';

/** What a check is given: the app, the page to use, and what the sense shares between checks in one pass. */
export interface CheckContext<Shared> {
  /** The app's address, with no path. */
  app: string;
  version: string;
  page: Page;
  shared: Shared;
  /** What the check's own requests to the app send besides the usual, as the page's do. */
  headers?: RequestHeaders | undefined;
}

export interface BrowserCheck<Shared> {
  id: string;
  /** The route as the app names it, such as `/products/:slug`. */
  route: string;
  /** At most this often, in milliseconds, except at once on a new version. For a check with a cost, such as one that sends a message. */
  every?: number;
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
  /** Sent with every request the pages make, besides the usual. */
  headers?: RequestHeaders | undefined;
  /** Whether to say what each check's pages left on the device and which other origins they asked. */
  device?: boolean;
}

export class BrowserSense<Shared> implements Sense {
  readonly name: Sense['name'];
  private readonly options: BrowserSenseOptions<Shared>;
  private readonly browser: SharedBrowser;

  constructor(options: BrowserSenseOptions<Shared>) {
    this.options = options;
    this.name = options.name;
    this.browser = new SharedBrowser(options.launch);
  }

  /** How often the checks that are limited may run, by check. */
  get intervals(): Record<string, number> {
    return Object.fromEntries(this.options.checks.flatMap((c) => (c.every ? [[c.id, c.every]] : [])));
  }

  /**
   * Runs `work` on a page of its own, in a context of its own, which is closed after. Its requests send `headers`
   * besides the usual, and not the sense's own: what the page is for is the caller's to say.
   */
  async withPage<T>(work: (page: Page) => Promise<T>, headers?: RequestHeaders): Promise<T> {
    const context = await this.newContext(headers);
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      return await work(page);
    } finally {
      await context.close();
    }
  }

  async pass(version: string, skip: ReadonlySet<string> = new Set()): Promise<Observation[]> {
    const context = await this.newContext(this.options.headers);
    const shared = this.options.shared();
    const observations: Observation[] = [];
    // What the pass's pages have left on the device so far, so each check is answerable for what it added.
    const kept = new Set<string>();
    try {
      for (const check of this.options.checks) {
        if (skip.has(check.id)) continue;
        observations.push(...(await this.look(check, context, version, shared, kept)));
      }
    } finally {
      await context.close();
    }
    return observations;
  }

  async close(): Promise<void> {
    await this.browser.close();
  }

  private async newContext(headers: RequestHeaders | undefined): Promise<BrowserContext> {
    const browser = await this.browser.ready();
    return browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: 'en-GB',
      ...(headers && { extraHTTPHeaders: headers }),
    });
  }

  private async look(
    check: BrowserCheck<Shared>,
    context: BrowserContext,
    version: string,
    shared: Shared,
    kept: Set<string>,
  ): Promise<Observation[]> {
    const { app, headers } = this.options;
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const watch = watching(page, new URL(app).origin);
    let finding: Finding | null = null;
    let trouble: string | undefined;
    try {
      finding = await within(this.options.timeout ?? 120_000, check.run({ app, version, page, shared, headers }));
    } catch (error) {
      if (error instanceof Found) finding = error.finding;
      else trouble = (error instanceof Error ? error.message : String(error)).split('\n')[0];
    }
    const { console, serverErrors, brokenImages, asked } = await watch.finish();
    let device: Device | undefined;
    if (this.options.device) {
      const now = await keptOnDevice(context, page);
      device = { kept: now.filter((thing) => !kept.has(thing)), asked };
      for (const thing of now) kept.add(thing);
    }
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
      const kept = found ? await this.keep(page, found, found.route ?? route, version, at) : { artifacts: [] };
      observations.push({
        check: id,
        route: found?.route ?? route,
        finding: found,
        ...kept,
        // A check that ended in trouble cannot be said to have passed, whatever else it did not see.
        ...(trouble && !found && { trouble }),
        ...(device && id === check.id && { device }),
      });
    }
    await page.close().catch(() => {});
    return observations;
  }

  /** Keeps the proof of a finding: a screenshot of the page it was seen on, and where on it the boxes were. */
  private async keep(
    page: Page,
    found: Finding,
    route: string,
    version: string,
    at?: string,
  ): Promise<Pick<Observation, 'artifacts' | 'look'>> {
    const { store } = this.options;
    const artifacts: ArtifactRef[] = [];
    let look: Observation['look'];
    // The check is over: an element it looked at that is not on this page should not be waited for.
    page.setDefaultTimeout(2_000);
    try {
      // A finding from the watch was seen on some page the check opened earlier, so go back to it.
      if (at && page.url() !== at) await page.goto(at, { waitUntil: 'load', timeout: 10_000 });
      const elements = (found.look ?? []).slice(0, 4);
      for (const box of elements)
        await page
          .locator(box.selector)
          .first()
          .scrollIntoViewIfNeeded({ timeout: 2_000 })
          .catch(() => {});
      const shot = await capture(page, store, { route, version, checks: elements }).catch((error) => {
        // Without boxes there is nothing different to try: the screenshot itself failed.
        if (!elements.length) throw error;
        this.options.log.warn({ err: String(error), route }, 'the boxes did not fit the screenshot; taking it without');
        return capture(page, store, { route, version });
      });
      artifacts.push(shot);
      if (shot.boxes.length) look = { path: pathOf(page.url()), elements };
    } catch (error) {
      this.options.log.warn({ err: String(error), route }, 'no screenshot of a finding');
    }
    return { artifacts, ...(look && { look }) };
  }
}

/**
 * The browser a sense uses, launched when first wanted. Callers that ask together share one launch, and a browser that
 * has died (Chromium can crash or be killed) is launched again rather than kept, so that it does not leave every later
 * pass failing until the pod restarts.
 */
export class SharedBrowser {
  private readonly launcher: () => Promise<Browser>;
  /** The browser, or its launch under way, which every caller waits on rather than starting another. */
  private browser: Promise<Browser> | undefined;

  constructor(launch: (() => Promise<Browser>) | undefined) {
    this.launcher = launch ?? (() => chromium.launch());
  }

  async ready(): Promise<Browser> {
    const launched = this.browser ?? this.launch();
    this.browser = launched;
    const browser = await launched;
    if (browser.isConnected()) return browser;
    // Whoever notices first forgets it; those who come after find the new launch.
    if (this.browser === launched) this.browser = undefined;
    return this.ready();
  }

  async close(): Promise<void> {
    const launched = this.browser;
    this.browser = undefined;
    await (await launched?.catch(() => undefined))?.close();
  }

  private launch(): Promise<Browser> {
    const launching = this.launcher();
    // A launch that failed is not kept: the next pass tries again.
    launching.catch(() => {
      if (this.browser === launching) this.browser = undefined;
    });
    return launching;
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

/**
 * What the browser says about how the page reached it rather than about the page's own code: served over plain
 * HTTP, a header that only works over HTTPS is ignored, and Chromium says so as an error. On the local cluster that
 * is every page, and no change to the app would quiet it, so it is not the app's error.
 */
export const aboutTheConnection = (text: string) =>
  /origin was untrustworthy|potentially trustworthy|insecure context|secure context/i.test(text);

/**
 * Everything the browser keeps for the app, as `<kind> <name>`: the context's cookies, whoever set them, its local
 * storage by origin, and, for the page's origin, its session storage, IndexedDB, Cache Storage and service workers.
 */
async function keptOnDevice(context: BrowserContext, page: Page): Promise<string[]> {
  const { cookies, origins } = await context.storageState();
  const kept = [
    ...cookies.map((cookie) => `cookie ${cookie.name}`),
    ...origins.flatMap(({ origin, localStorage }) =>
      localStorage.map(({ name }) => `localStorage ${name} on ${origin}`),
    ),
  ];
  if (!/^https?:/.test(page.url())) return kept;
  const origin = new URL(page.url()).origin;
  // A script, since this package is type-checked for Node.
  const stored = await page
    .evaluate(`(async () => [
      ...Object.keys(sessionStorage).map((key) => 'sessionStorage ' + key),
      ...(await indexedDB.databases()).map((db) => 'IndexedDB ' + db.name),
      ...(globalThis.caches ? await caches.keys() : []).map((name) => 'Cache Storage ' + name),
      ...((await navigator.serviceWorker?.getRegistrations()) ?? []).map((worker) => 'service worker ' + worker.scope),
    ])()`)
    .catch(() => []);
  return [...kept, ...(stored as string[]).map((thing) => `${thing} on ${origin}`)];
}

/** Listens to a page for what a visitor would suffer without being asked about it. */
function watching(page: Page, origin: string) {
  const asked = new Set<string>();
  const consoleErrors: Array<{ level: 'error'; text: string; source?: string; page: string }> = [];
  const serverErrors: Array<{ path: string; status: number; evidence: Evidence; page: string }> = [];
  const brokenImages: Array<{ path: string; reason: string; evidence: Evidence; page: string }> = [];

  const onConsole = (message: { type(): string; text(): string; location(): { url: string; lineNumber: number } }) => {
    // The browser also reports each failed request here; those are found below, with more to say about them.
    if (message.type() !== 'error' || message.text().startsWith('Failed to load resource')) return;
    if (aboutTheConnection(message.text())) return;
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
  const onRequest = (request: Request) => {
    const url = new URL(request.url());
    if (/^(https?|wss?):$/.test(url.protocol) && url.origin !== origin) asked.add(url.origin);
  };
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
  page.on('request', onRequest);
  return {
    /** Stops listening, once the responses already heard of have been read. */
    finish: async () => {
      await Promise.all(pending);
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
      page.off('response', onResponseSoon);
      page.off('requestfailed', onFailed);
      page.off('request', onRequest);
      return { console: consoleErrors, serverErrors, brokenImages, asked: [...asked] };
    },
  };
}
