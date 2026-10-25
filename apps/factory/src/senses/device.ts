/**
 * What a browser keeps for a site on the device. The journeys gate fails a change to the app whose pages start to keep
 * anything (`senses/browser.ts`, `device`), and the console's browser tests fail on anything but Martin's session cookie
 * (`apps/console/e2e/support.ts`): one reading, so the two mean the same by "nothing on the device".
 *
 * The app may keep one thing, and only for a browser that asked for it: its preview cookie, set by `?preview=<flag>`
 * to show that browser a flag at its opt-in stage. Its contract is in docs/COMPONENTS/FEATURE-FLAGS.md, and
 * `previewCookieFaults` holds a cookie to it.
 */
import type { BrowserContext, Cookie, Page } from 'playwright';

/** The app's preview cookie: its name, and the attributes it is set with (docs/COMPONENTS/FEATURE-FLAGS.md). */
export const PREVIEW_COOKIE = {
  name: 'preview',
  path: '/',
  sameSite: 'Lax',
  httpOnly: true,
  /** `Max-Age`, from the latest ask: a day. */
  maxAgeSeconds: 86_400,
} as const;

/** A flag's name, as a preview may ask for it: lower-case letters and digits, in words joined by hyphens. */
export const FLAG_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** What may be kept: the preview cookie for the flags a check asked to preview, on the app's own host. */
export interface Allowance {
  /** The app's address. */
  app: string;
  /** The flags asked for, by `?preview=`, by the pass so far. None, and the preview cookie is kept like any other. */
  previewed: ReadonlySet<string>;
}

/**
 * Everything the browser keeps, as `<kind> <name>`: the context's cookies, whoever set them and whether a script could
 * read them, its local storage by origin, and, for the page's origin, its session storage, IndexedDB, Cache Storage and
 * service workers. Throws when the page cannot be read, as between two documents.
 */
export async function keptOnDevice(context: BrowserContext, page: Page): Promise<string[]> {
  return (await onDevice(context, page)).kept;
}

/**
 * What the browser keeps, as `keptOnDevice` reads it, split into what `allowance` allows and the rest. A preview cookie
 * that breaks its contract is kept, with what is wrong with it; with no preview asked for, it is kept like any cookie.
 */
export async function onDevice(
  context: BrowserContext,
  page: Page,
  allowance?: Allowance,
): Promise<{ kept: string[]; allowed: string[] }> {
  const { cookies, origins } = await context.storageState();
  const kept: string[] = [];
  const allowed: string[] = [];
  const now = Date.now() / 1000;
  for (const cookie of cookies) {
    const thing = `cookie ${cookie.name}`;
    if (!allowance?.previewed.size || cookie.name !== PREVIEW_COOKIE.name) kept.push(thing);
    else {
      const faults = previewCookieFaults(cookie, allowance, now);
      if (faults.length) kept.push(`${thing} (${faults.join('; ')})`);
      else allowed.push(thing);
    }
  }
  kept.push(
    ...origins.flatMap(({ origin, localStorage }) =>
      localStorage.map(({ name }) => `localStorage ${name} on ${origin}`),
    ),
  );
  if (page.isClosed() || !/^https?:/.test(page.url())) return { kept, allowed };
  const origin = new URL(page.url()).origin;
  // A script, since this package is type-checked for Node.
  const stored = (await page.evaluate(`(async () => [
    ...Object.keys(sessionStorage).map((key) => 'sessionStorage ' + key),
    ...(await indexedDB.databases()).map((db) => 'IndexedDB ' + db.name),
    ...(globalThis.caches ? await caches.keys() : []).map((name) => 'Cache Storage ' + name),
    ...((await navigator.serviceWorker?.getRegistrations()) ?? []).map((worker) => 'service worker ' + worker.scope),
  ])()`)) as string[];
  return { kept: [...kept, ...stored.map((thing) => `${thing} on ${origin}`)], allowed };
}

/**
 * How a preview cookie breaks its contract, read at `now` (seconds since the epoch), or nothing when it keeps to it: on
 * the app's own host alone, at `/`, `HttpOnly`, `SameSite=Lax`, `Secure` exactly when the app is served over HTTPS,
 * lasting no more than a day, and naming only flags that were asked for, each once.
 */
export function previewCookieFaults(cookie: Cookie, { app, previewed }: Allowance, now: number): string[] {
  const url = new URL(app);
  const https = url.protocol === 'https:';
  const names = cookie.value.split('.');
  const faults = [
    // Playwright gives a host-only cookie its host, and one set with `Domain` a leading dot.
    cookie.domain !== url.hostname && `for ${cookie.domain}, not ${url.hostname} alone`,
    cookie.path !== PREVIEW_COOKIE.path && `on the path ${cookie.path}, not ${PREVIEW_COOKIE.path}`,
    !cookie.httpOnly && 'readable by a script',
    cookie.sameSite !== PREVIEW_COOKIE.sameSite && `SameSite=${cookie.sameSite}, not ${PREVIEW_COOKIE.sameSite}`,
    cookie.secure !== https && (https ? 'not Secure on HTTPS' : 'Secure on plain HTTP'),
    cookie.expires < 0
      ? 'with no Max-Age'
      : // A second's grace, for the expiry's rounding.
        cookie.expires - now > PREVIEW_COOKIE.maxAgeSeconds + 1 &&
        `lasting ${Math.round((cookie.expires - now) / 3600)} hours, longer than a day`,
    !names.every((name) => FLAG_NAME.test(name)) && 'not a list of flag names',
    new Set(names).size !== names.length && 'naming a flag twice',
    ...names
      .filter((name) => FLAG_NAME.test(name) && !previewed.has(name))
      .map((name) => `naming ${name}, which was not asked for`),
  ];
  return faults.filter((fault): fault is string => typeof fault === 'string');
}
