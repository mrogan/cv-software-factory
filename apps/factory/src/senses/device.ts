/**
 * What a browser keeps for a site on the device. The journeys gate fails a change to the app whose pages start to keep
 * anything (`senses/browser.ts`, `device`), and the console's browser tests fail on anything but Martin's session cookie
 * (`apps/console/e2e/support.ts`): one reading, so the two mean the same by "nothing on the device".
 */
import type { BrowserContext, Page } from 'playwright';

/**
 * Everything the browser keeps, as `<kind> <name>`: the context's cookies, whoever set them and whether a script could
 * read them, its local storage by origin, and, for the page's origin, its session storage, IndexedDB, Cache Storage and
 * service workers. Throws when the page cannot be read, as between two documents.
 */
export async function keptOnDevice(context: BrowserContext, page: Page): Promise<string[]> {
  const { cookies, origins } = await context.storageState();
  const kept = [
    ...cookies.map((cookie) => `cookie ${cookie.name}`),
    ...origins.flatMap(({ origin, localStorage }) =>
      localStorage.map(({ name }) => `localStorage ${name} on ${origin}`),
    ),
  ];
  if (page.isClosed() || !/^https?:/.test(page.url())) return kept;
  const origin = new URL(page.url()).origin;
  // A script, since this package is type-checked for Node.
  const stored = (await page.evaluate(`(async () => [
    ...Object.keys(sessionStorage).map((key) => 'sessionStorage ' + key),
    ...(await indexedDB.databases()).map((db) => 'IndexedDB ' + db.name),
    ...(globalThis.caches ? await caches.keys() : []).map((name) => 'Cache Storage ' + name),
    ...((await navigator.serviceWorker?.getRegistrations()) ?? []).map((worker) => 'service worker ' + worker.scope),
  ])()`)) as string[];
  return [...kept, ...stored.map((thing) => `${thing} on ${origin}`)];
}
