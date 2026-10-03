/**
 * Asking the app for something over HTTP, and keeping the exchange as evidence. For what a check needs without a
 * browser: the app's own JSON, and whether a link opens.
 */
import type { Evidence } from '@software-factory/events';
import type { Response as BrowserResponse } from 'playwright';

type HttpEvidence = Extract<Evidence, { kind: 'http' }>;

export interface Exchange {
  /** The status of the last response, or null when none came (the connection failed, or redirects never ended). */
  status: number | null;
  /** The body of the last response, as text. */
  body: string;
  /** The last response's content type, without parameters, or null. */
  type: string | null;
  evidence: HttpEvidence;
  /** Why no answer came, when none did. */
  failure?: 'redirect loop' | 'no answer';
}

/** The headers every exchange records: the few a reviewer of a signal would ask about. */
const HEADERS = ['content-type', 'cache-control', 'location'] as const;

const MAX_REDIRECTS = 10;

/** What a path asks for, as an event may record it: the path and its query, never the host. */
export const pathOf = (url: string | URL, base?: string): string => {
  const { pathname, search } = new URL(url, base);
  return `${pathname}${search}`.slice(0, 300);
};

/** GETs a path of the app, following redirects by hand so each one is recorded. */
export async function exchange(app: string, path: string, init: { signal?: AbortSignal } = {}): Promise<Exchange> {
  const started = performance.now();
  const redirects: HttpEvidence['redirects'] = [];
  const seen = new Set<string>();
  let url = new URL(path, app);
  let firstByteMs = 0;
  for (;;) {
    seen.add(url.href);
    let response: Response;
    try {
      response = await fetch(url, { redirect: 'manual', signal: init.signal ?? AbortSignal.timeout(15_000) });
    } catch {
      return finish(null, '', null, 'no answer');
    }
    firstByteMs = Math.round(performance.now() - started);
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      redirects.push({ status: response.status, location: location.slice(0, 300) });
      url = new URL(location, url);
      if (seen.has(url.href) || redirects.length > MAX_REDIRECTS) return finish(response, '', null, 'redirect loop');
      continue;
    }
    return finish(response, await response.text().catch(() => ''), response.headers.get('content-type'));
  }

  function finish(response: Response | null, body: string, type: string | null, failure?: Exchange['failure']) {
    const evidence: HttpEvidence = {
      kind: 'http',
      method: 'GET',
      url: pathOf(path, app),
      status: response?.status ?? null,
      headers: Object.fromEntries(HEADERS.map((name) => [name, response?.headers.get(name)?.slice(0, 300) ?? null])),
      timings: { firstByteMs, totalMs: Math.round(performance.now() - started) },
      redirects,
    };
    return {
      status: response?.status ?? null,
      body,
      type: type?.split(';')[0]?.trim().toLowerCase() ?? null,
      evidence,
      ...(failure && { failure }),
    };
  }
}

/** The version the app says it is running, from its `/version`. */
export async function versionOf(app: string): Promise<string> {
  const answer = await exchange(app, '/version');
  let commit: unknown;
  try {
    commit = (JSON.parse(answer.body) as { commit?: unknown }).commit;
  } catch {
    // Not JSON: the check below says so.
  }
  if (answer.status !== 200 || typeof commit !== 'string') {
    throw new Error(`${app}/version did not say what version is running (status ${answer.status ?? 'none'})`);
  }
  return commit;
}

/** The exchange a browser had, as evidence: its request, and the redirects before the response. */
export async function evidenceOf(response: BrowserResponse): Promise<HttpEvidence> {
  const request = response.request();
  const redirects: HttpEvidence['redirects'] = [];
  for (let from = request.redirectedFrom(); from && redirects.length < MAX_REDIRECTS; from = from.redirectedFrom()) {
    const earlier = await from.response();
    redirects.unshift({
      status: Math.min(399, Math.max(300, earlier?.status() ?? 302)),
      location: (earlier ? (await earlier.allHeaders()).location : undefined) ?? 'unknown',
    });
  }
  const headers = await response.allHeaders();
  const timing = request.timing();
  return {
    kind: 'http',
    method: request.method() === 'POST' ? 'POST' : 'GET',
    url: pathOf(response.url()),
    status: response.status(),
    headers: Object.fromEntries(HEADERS.map((name) => [name, headers[name]?.slice(0, 300) ?? null])),
    timings: {
      firstByteMs: Math.max(0, Math.round(timing.responseStart - timing.requestStart)),
      totalMs: Math.max(0, Math.round(timing.responseEnd)),
    },
    redirects,
  };
}
