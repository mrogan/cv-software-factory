/**
 * Judging a crawl: what is wrong with the pages and assets it reached, by the checks any site should pass. Each
 * issue names the route it belongs on, as a template, and the page to screenshot.
 *
 * Where an issue belongs:
 * - what is wrong with a page itself (its headers, its console, its accessibility, its speed) belongs on that
 *   page's route, and is `scope: 'page'`: a class found on every page crawled is one signal for `*`;
 * - a broken link or image belongs on the route of the page that holds it, where a visitor meets it;
 * - a server error, a redirect loop, a slow answer or an uncached asset belongs on the route that was asked for.
 */
import type { Evidence, SymptomClass } from '@software-factory/events';
import type { Check } from '../capture.ts';
import { type Exchange, exchange } from '../senses/http.ts';
import type { Finding } from '../senses/types.ts';
import type { Crawl, Resource } from './crawl.ts';

/** An answer slower than this, in milliseconds, is slow. It is generous: the check is for answers that hurt. */
export const SLOW = 2_000;

/** The headers any site should send on its pages, as `[name, what to look for]`. */
const SECURITY_HEADERS = ['content-security-policy', 'x-content-type-options', 'referrer-policy', 'x-frame-options'];

/** Every header the checks read, so that an exchange's evidence shows what was looked at. */
export const RECORDED = [...SECURITY_HEADERS, 'strict-transport-security', 'expires', 'server', 'x-powered-by'];

export interface Issue extends Finding {
  route: string;
  /** The path of the page to screenshot. */
  at: string;
  scope: 'page' | 'other';
  evidence: Evidence[];
}

/**
 * Something the crawl could not tell: a route on which the checks for these classes (any, if none are named) can
 * be neither passed nor failed, as a check that threw is neither.
 */
export interface Trouble {
  route: string;
  symptoms?: readonly SymptomClass[];
  message: string;
}

/** What opening a page in a browser tells of: the checks that cannot be made when it could not be opened. */
const OF_A_PAGE = ['missing-header', 'browser-error', 'missing-alt', 'low-contrast', 'unlabelled-field'] as const;

export interface Judged {
  issues: Issue[];
  trouble: Trouble[];
}

export interface JudgeInput {
  crawl: Crawl;
  errors: ErrorPage[];
  /** Whether the app is served over HTTPS, which is when it should say so with Strict-Transport-Security. */
  secure: boolean;
  version: string;
  /** Maps a path to its route template. */
  template(path: string): string;
  /** An answer slower than this, in milliseconds, is slow: `SLOW` unless a test needs it shorter. */
  slow?: number;
}

const STATIC = /\.(?:js|mjs|css|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf)$/i;

const quoted = (path: string) => path.replaceAll('"', '');

export function judge({ crawl, errors, secure, version, template, slow = SLOW }: JudgeInput): Judged {
  const issues: Issue[] = [];
  const trouble: Trouble[] = [];
  const byPath = new Map(crawl.resources.map((r) => [r.path, r]));

  for (const resource of crawl.resources) {
    const { answer, path, kind, from } = resource;
    const target = template(path);
    const holder = template(from);
    const where: Check[] = [{ selector: `[href$="${quoted(path)}"], [src$="${quoted(path)}"]`, kind: 'problem' }];
    const isPage = crawl.pages.some((page) => page.path === path);
    if (answer.failure === 'redirect loop') {
      issues.push({
        symptom: 'redirect-loop',
        route: target,
        at: from,
        scope: 'other',
        message: `${path} redirects round in a circle.`,
        evidence: [answer.evidence],
        look: where,
      });
      continue;
    }
    const status = answer.status;
    if (status === null) {
      // No answer at all (refused, reset, or too slow to wait for) is not a pass: whether it is broken is not known.
      // That holds for the route asked for, and for the check on the page that holds the link or image.
      const message = `${path}${path === from ? '' : `, from ${from},`} gave no answer.`;
      trouble.push({ route: target, message });
      if (kind !== 'asset')
        trouble.push({ route: holder, symptoms: [kind === 'image' ? 'broken-image' : 'broken-link'], message });
      continue;
    }
    if (status >= 500) {
      issues.push({
        symptom: 'server-error',
        route: target,
        at: kind === 'link' ? path : from,
        scope: 'other',
        message: `${path} answered ${status}.`,
        evidence: [answer.evidence],
      });
    } else if (status >= 400) {
      const image = kind === 'image';
      issues.push({
        symptom: image ? 'broken-image' : 'broken-link',
        route: holder,
        at: from,
        scope: 'other',
        message: `${image ? 'The image' : 'The link to'} ${path}, on ${from}, answered ${status}.`,
        evidence: [answer.evidence],
        look: where,
      });
    } else if (kind === 'image' && status < 300 && !answer.type?.startsWith('image/')) {
      issues.push({
        symptom: 'broken-image',
        route: holder,
        at: from,
        scope: 'other',
        message: `The image ${path}, on ${from}, answered with ${answer.type ?? 'no type'}, not an image.`,
        evidence: [answer.evidence],
        look: where,
      });
    }
    const totalMs = answer.evidence.timings.totalMs;
    if (totalMs > slow) {
      issues.push({
        symptom: 'slow-response',
        route: target,
        at: isPage ? path : from,
        scope: isPage ? 'page' : 'other',
        message: `${path} took ${(totalMs / 1000).toFixed(1)} s to answer.`,
        evidence: [answer.evidence],
      });
    }
    if (status === 200 && !isPage && (kind !== 'link' || STATIC.test(path.split('?')[0] ?? '')) && !cached(answer)) {
      issues.push({
        symptom: 'not-cached',
        route: target,
        at: from,
        scope: 'other',
        message: `${path} is a static asset and says nothing to let it be kept: its Cache-Control is ${answer.headers['cache-control'] ? `"${answer.headers['cache-control']}"` : 'missing'}.`,
        evidence: [answer.evidence],
      });
    }
  }

  for (const { path, message } of crawl.unbrowsed) {
    trouble.push({
      route: template(path),
      symptoms: OF_A_PAGE,
      message: `${path} answered but could not be opened in a browser: ${message}`,
    });
  }

  for (const page of crawl.pages) {
    const route = template(page.path);
    const resource = byPath.get(page.path) as Resource;
    const missing = missingHeaders(resource.answer, secure);
    if (missing.length) {
      issues.push({
        symptom: 'missing-header',
        route,
        at: page.path,
        scope: 'page',
        message: `${page.path} does not send ${missing.join(', ')}.`,
        evidence: [resource.answer.evidence],
      });
    }
    if (page.console.length) {
      issues.push({
        symptom: 'browser-error',
        route,
        at: page.path,
        scope: 'page',
        message: `The browser reported ${page.console.length === 1 ? 'an error' : `${page.console.length} errors`} on ${page.path}: ${page.console[0]?.text}`,
        evidence: [
          {
            kind: 'console',
            route,
            version,
            messages: page.console.slice(0, 20).map((m) => ({ level: 'error' as const, ...m })),
          },
        ],
      });
    }
    for (const symptom of ['missing-alt', 'low-contrast', 'unlabelled-field'] as const) {
      const found = page.accessibility.filter((issue) => issue.symptom === symptom);
      if (!found.length) continue;
      const elements = found.flatMap((issue) => issue.elements);
      issues.push({
        symptom,
        route,
        at: page.path,
        scope: 'page',
        message: `${page.path} has ${elements.length} ${elements.length === 1 ? 'element' : 'elements'} that axe reports (${found.map((f) => f.rule).join(', ')}): ${found[0]?.help}.`,
        evidence: [
          {
            kind: 'accessibility',
            route,
            version,
            findings: found
              .slice(0, 20)
              .map(({ rule, impact, help, elements: els }) => ({ rule, impact, help, elements: els })),
          },
        ],
        look: elements.slice(0, 4).map((e) => ({ selector: e.selector, kind: 'problem' as const })),
      });
    }
  }

  for (const error of errors) {
    const leaked = leaks(error.answer);
    if (!leaked.length) continue;
    issues.push({
      symptom: 'leaks-detail',
      route: error.route,
      at: '/',
      scope: 'other',
      message: `The error page for ${error.what} gives away ${leaked.join(', ')}.`,
      evidence: [error.answer.evidence],
    });
  }
  return { issues, trouble };
}

/** Whether an asset says it may be kept for some time. */
function cached(answer: Exchange): boolean {
  const control = answer.headers['cache-control'] ?? '';
  if (/\b(?:no-store|no-cache)\b|max-age=0\b/i.test(control)) return false;
  if (/\bimmutable\b|\b(?:s-)?max-age=[1-9]/i.test(control)) return true;
  return Boolean(answer.headers.expires) && Date.parse(answer.headers.expires as string) > Date.now();
}

function missingHeaders(answer: Exchange, secure: boolean): string[] {
  const { headers } = answer;
  const missing = SECURITY_HEADERS.filter((name) => {
    if (name === 'x-frame-options')
      return !headers[name] && !/frame-ancestors/i.test(headers['content-security-policy'] ?? '');
    if (name === 'x-content-type-options') return !/nosniff/i.test(headers[name] ?? '');
    return !headers[name];
  });
  if (secure && !headers['strict-transport-security']) missing.push('strict-transport-security');
  return missing;
}

/** A page the app gave for something that is not a page: where it was asked for, and what it said. */
export interface ErrorPage {
  /** What was asked for, in words, for the message. */
  what: string;
  /** The route the request belongs on. */
  route: string;
  answer: Exchange;
}

/**
 * Asks for a page that is not there, and sends a request that is malformed (a path with a broken percent-escape),
 * which are the two errors any visitor or crawler can cause.
 */
export async function askForErrors(app: string): Promise<ErrorPage[]> {
  const missing = `/no-such-page-${Math.random().toString(36).slice(2, 8)}`;
  return Promise.all([
    exchange(app, missing, { record: RECORDED }).then((answer) => ({
      what: 'a page that is not there',
      route: '/:missing',
      answer,
    })),
    exchange(app, '/%E0%A4%A', { record: RECORDED }).then((answer) => ({
      what: 'a malformed request',
      route: '/:malformed',
      answer,
    })),
  ]);
}

/** What an error page gives away that a visitor has no use for: its workings. */
const GIVEAWAYS: Array<[string, RegExp]> = [
  [
    'a stack trace',
    /\n\s+at\s+[^\n]*\(.*:\d+:\d+\)|\n\s+at\s+\S+:\d+:\d+|Traceback \(most recent call last\)|Exception in thread|\bStack trace\b/i,
  ],
  [
    'a file path',
    /(?:\/(?:Users|home|var|usr|app|srv|opt|workspace|node_modules|src)\/[\w.@-]+(?:\/[\w.@-]+)+)|[A-Za-z]:\\(?:[\w.-]+\\)+/,
  ],
  [
    'a framework or version banner',
    /\b(?:Express|Fastify|Koa|Django|Rails|Flask|Werkzeug|Laravel|Spring|ASP\.NET|Apache|nginx|Tomcat|Jetty)\b[\s/]*v?\d|Node\.js v\d+|Cannot (?:GET|POST|PUT|DELETE) \//i,
  ],
  ['a database error', /SQLITE_\w+|SQLSTATE|syntax error at or near|\bORA-\d+|\bSQL syntax\b/i],
];

export function leaks(answer: Exchange): string[] {
  const found = GIVEAWAYS.filter(([, pattern]) => pattern.test(answer.body)).map(([name]) => name);
  const { server, 'x-powered-by': poweredBy } = answer.headers;
  if (poweredBy || (server && /\d+\.\d+/.test(server))) found.push('its software in a header');
  return found;
}
