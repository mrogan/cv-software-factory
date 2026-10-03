/**
 * Crawling: from the home page, every page and asset it leads to on the same origin: links, images, scripts,
 * stylesheets and icons. Each is asked for over HTTP, so that its status, headers and time are what any client
 * would see. Each HTML page that answers is then opened in a browser, which says what its console said, what links
 * it holds once its scripts have run, and what axe finds wrong with it. This module gathers; judging is in
 * `judge.ts`.
 */

import { AxeBuilder } from '@axe-core/playwright';
import type { SymptomClass } from '@software-factory/events';
import type { BrowserContext, Page } from 'playwright';
import { aboutTheConnection } from '../senses/browser.ts';
import { type Exchange, exchange, pathOf } from '../senses/http.ts';

/** How a resource was reached: a link to follow, an image on a page, or a script, stylesheet or icon. */
export type Kind = 'link' | 'image' | 'asset';

export interface Resource {
  /** The path and query asked for. */
  path: string;
  kind: Kind;
  /** The page that first led to it. The home page leads to itself. */
  from: string;
  answer: Exchange;
}

export interface AccessibilityIssue {
  rule: string;
  impact: 'minor' | 'moderate' | 'serious' | 'critical';
  help: string;
  symptom: Extract<SymptomClass, 'missing-alt' | 'low-contrast' | 'unlabelled-field'>;
  /** Where on the page, when the element is in view: in CSS pixels from its top left. */
  elements: Array<{ selector: string; box?: { x: number; y: number; width: number; height: number } }>;
}

/** What opening a page in a browser showed. */
export interface Browsed {
  path: string;
  console: Array<{ text: string; source?: string }>;
  accessibility: AccessibilityIssue[];
}

export interface Crawl {
  resources: Resource[];
  pages: Browsed[];
  /** Set when the crawl stopped at its cap, so what it did not reach is unknown. */
  capped: boolean;
}

export interface CrawlOptions {
  app: string;
  context: BrowserContext;
  /** The most resources asked for. */
  limit?: number;
  /** Headers to keep in each exchange's evidence besides the usual. */
  record: readonly string[];
}

/** Axe rules that name a class of defect, and the class. Rules that fit no class are left out, not forced. */
const RULES: Record<string, AccessibilityIssue['symptom']> = {
  'image-alt': 'missing-alt',
  'input-image-alt': 'missing-alt',
  'area-alt': 'missing-alt',
  'role-img-alt': 'missing-alt',
  'svg-img-alt': 'missing-alt',
  'color-contrast': 'low-contrast',
  label: 'unlabelled-field',
  'select-name': 'unlabelled-field',
  'aria-input-field-name': 'unlabelled-field',
};

/** What the page holds, once its scripts have run: where it leads. Runs in the browser, so it is a string. */
const REFERENCES = `(() => {
  const all = (selector, attribute) => [...document.querySelectorAll(selector)].map((e) => e[attribute]).filter(Boolean);
  return {
    links: all('a[href]', 'href'),
    images: all('img[src]', 'currentSrc').concat(all('img[src]', 'src')),
    assets: all('script[src]', 'src').concat(all('link[rel~="stylesheet"][href]', 'href'), all('link[rel~="icon"][href]', 'href')),
  };
})()`;

export async function crawl({ app, context, limit = 150, record }: CrawlOptions): Promise<Crawl> {
  const origin = new URL(app).origin;
  const result: Crawl = { resources: [], pages: [], capped: false };
  const queued = new Map<string, { kind: Kind; from: string }>([['/', { kind: 'link', from: '/' }]]);
  const todo = ['/'];

  const enqueue = (urls: string[], kind: Kind, from: string) => {
    for (const href of urls) {
      let url: URL;
      try {
        url = new URL(href);
      } catch {
        continue;
      }
      if (url.origin !== origin) continue;
      const path = pathOf(url);
      if (!queued.has(path)) {
        queued.set(path, { kind, from });
        todo.push(path);
      }
    }
  };

  for (let next = todo.shift(); next !== undefined; next = todo.shift()) {
    if (result.resources.length >= limit) {
      result.capped = true;
      break;
    }
    const { kind, from } = queued.get(next) as { kind: Kind; from: string };
    const answer = await exchange(app, next, { record });
    result.resources.push({ path: next, kind, from, answer });
    if (kind !== 'link' || answer.status !== 200 || answer.type !== 'text/html') continue;
    const browsed = await browse(context, new URL(next, app).href, next);
    result.pages.push(browsed.page);
    enqueue(browsed.references.links, 'link', next);
    enqueue(browsed.references.images, 'image', next);
    enqueue(browsed.references.assets, 'asset', next);
  }
  return result;
}

async function browse(context: BrowserContext, url: string, path: string) {
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const messages: Browsed['console'] = [];
  page.on('console', (message) => {
    // The browser also reports each failed request here; the crawl asks for those itself, and says more of them.
    if (message.type() !== 'error' || message.text().startsWith('Failed to load resource')) return;
    if (aboutTheConnection(message.text())) return;
    const { url: source, lineNumber } = message.location();
    messages.push({
      text: message.text().trim().slice(0, 300),
      ...(source && { source: `${pathOf(source).split('?')[0]}:${lineNumber}`.slice(0, 300) }),
    });
  });
  page.on('pageerror', (error) => messages.push({ text: `Uncaught ${error.message}`.slice(0, 300) }));
  try {
    await page.goto(url, { waitUntil: 'load' });
    const references = (await page.evaluate(REFERENCES)) as { links: string[]; images: string[]; assets: string[] };
    return { page: { path, console: messages, accessibility: await accessibility(page) }, references };
  } finally {
    await page.close().catch(() => {});
  }
}

async function accessibility(page: Page): Promise<AccessibilityIssue[]> {
  const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
  const { violations } = await new AxeBuilder({ page }).analyze();
  const issues: AccessibilityIssue[] = [];
  for (const violation of violations) {
    const symptom = RULES[violation.id];
    if (!symptom) continue;
    const elements: AccessibilityIssue['elements'] = [];
    for (const node of violation.nodes.slice(0, 10)) {
      const selector = String(Array.isArray(node.target[0]) ? node.target[0].at(-1) : node.target[0]).slice(0, 300);
      const found = await page
        .locator(selector)
        .first()
        .boundingBox({ timeout: 1_000 })
        .catch(() => null);
      const x = found ? Math.max(0, Math.round(found.x)) : 0;
      const y = found ? Math.max(0, Math.round(found.y)) : 0;
      const width = found ? Math.round(Math.min(found.x + found.width, viewport.width) - x) : 0;
      const height = found ? Math.round(Math.min(found.y + found.height, viewport.height) - y) : 0;
      elements.push({ selector, ...(width > 0 && height > 0 && { box: { x, y, width, height } }) });
    }
    if (!elements.length) continue;
    issues.push({
      rule: violation.id,
      impact: violation.impact ?? 'minor',
      help: violation.help.slice(0, 200),
      symptom,
      elements,
    });
  }
  return issues;
}
